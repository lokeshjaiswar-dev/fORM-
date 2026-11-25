import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPgBossQueue, installQueueSchema, parseJobKeyring, verifyJob, type JobKeyring, type PgBossQueue } from '@form/adapters/queue';
import { createPostgresSearchIndex } from '@form/adapters/search';
import { editionSummary, runtimeEdition, type RuntimeEdition } from '@form/config';
import { createDb, provision, withTenant, type DbHandle } from '@form/db';
import { DEFAULT_COMPLIANCE, REGISTRY } from '@form/registry';
import type { Locale } from '@form/schema';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { createFileStore } from '../src/files.ts';
import { encrypted, sensitive } from '../src/submissions/test-fixtures.ts';
import { createVersionLoader, type VersionLoader } from '../src/submit/live.ts';
import { submit as submitPipeline } from '../src/submit/pipeline.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

/*
 * WP-1.12: what a stored response sets in motion inside its own transaction (architecture §2.5). One `submission.fanout`
 * job through the pg-boss adapter on the same transaction (so a rolled-back submit and a replay enqueue none), the
 * search document (never an encrypt or sensitive field, never a value derived from one), and the gap-free unique IDs.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
/** More than any test sends from one address, so the throttle never speaks. */
const BUDGET = { max: 100_000, windowSeconds: 600 };

let app: FastifyInstance;
let owner: pg.Pool;
let appDb: DbHandle;
let queue: PgBossQueue;
let keyring: JobKeyring;
let edition: RuntimeEdition;
let secret: () => Uint8Array;
let dir: string;
let orgId: string;
let userId: string;

const as = () => ({ 'x-fr-dev-user': userId, 'x-fr-org': orgId, ...BROWSER });
const short = (value: string) => ({ type: 'short_text', value });
const num = (value: string) => ({ type: 'number', value });

type Block = ReturnType<typeof fieldBlock>;

/** A block of any registry type on its default config (`config` merged over it), as the builder creates one. */
function blockOf(id: string, type: string, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Block {
  const defaults = DEFAULT_COMPLIANCE[type as keyof typeof DEFAULT_COMPLIANCE];
  const registered = REGISTRY[type as keyof typeof REGISTRY];
  return {
    id,
    type,
    key: id,
    label: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: id }] }] },
    required: false,
    compliance: { ...defaults, purposeIds: defaults.classification === 'none' ? [] : ['pur_1'] },
    config: { ...registered.defaultConfig('en-IN' as Locale), ...config },
    ...extra,
  } as unknown as Block;
}

const ref = (blockId: string) => ({ k: 'ref', ref: { kind: 'answer', blockId } });
const times = (left: string, right: string) => ({ k: 'binary', op: '*', left: ref(left), right: ref(right) });
const calculation = (id: string, expr: unknown) => blockOf(id, 'calculation', { expr, resultType: 'number', display: 'visible' });
const uniqueId = (id: string, config: Record<string, unknown> = {}) => blockOf(id, 'unique_id', { prefix: ['T-'], padTo: 3, startAt: 1, resetEvery: 'never', ...config });

/** A rule that hides `targets` while the text field `when` equals "skip". */
const hideWhenSkip = (when: string, targets: string[]) => ({
  id: `rule_${targets.join('_')}`,
  enabled: true,
  when: {
    kind: 'group',
    id: 'group_1',
    combinator: 'all',
    children: [{ kind: 'condition', id: 'cond_1', left: { kind: 'ref', ref: { kind: 'answer', blockId: when } }, op: 'eq', right: { kind: 'literal', value: { type: 'text', value: 'skip' } } }],
  },
  then: [{ type: 'hide', targets }],
});

interface Published {
  id: string;
  slug: string;
  versionId: string;
}

async function publishBlocks(title: string, blocks: Block[], rules: unknown[] = []): Promise<Published> {
  const { id } = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(), payload: { title } })).json<{ id: string }>();
  const draft = draftWith(id, blocks, title);
  const put = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...as(), 'if-match': '0' }, payload: { draft: { ...draft, logic: { ...draft.logic, rules } } } });
  expect(put.statusCode, put.body).toBe(200);
  const live = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(), payload: {} });
  expect(live.statusCode, live.body).toBe(200);
  return { id, ...live.json<{ slug: string; versionId: string }>() };
}

async function setAccess(formId: string, patch: Record<string, unknown>): Promise<void> {
  const current = await app.inject({ url: `/v1/forms/${formId}/access`, headers: as() });
  const res = await app.inject({
    method: 'PUT',
    url: `/v1/forms/${formId}/access`,
    headers: { ...as(), 'if-match': String(current.json<{ rev: number }>().rev) },
    payload: { enabled: true, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72, ...patch },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** A respondent's POST; every call is a new submission (a fresh Idempotency-Key) unless `key` says otherwise. */
const submit = (f: Published, answers: Record<string, unknown>, key: string = randomUUID()) =>
  app.inject({
    method: 'POST',
    url: `/v1/p/${f.slug}/submissions`,
    headers: { 'idempotency-key': key },
    payload: { formVersionId: f.versionId, answers, fields: [], locale: 'en-IN' },
  });

interface JobRow {
  id: string;
  state: string;
  data: Record<string, unknown> & { resource: { type: string; id: string }; orgId: string; data: Record<string, unknown> };
}

/** The `submission.fanout` jobs in the queue that name this form (the envelope's resource). */
async function jobsFor(formId: string): Promise<JobRow[]> {
  const { rows } = await owner.query<JobRow>(`select id, state, data from pgboss.job where name = 'submission.fanout' and data -> 'resource' ->> 'id' = $1 order by created_on`, [formId]);
  return rows;
}

const count = async (text: string, ...params: unknown[]): Promise<number> => Number((await owner.query(text, params)).rows[0].n);

/** The deployment's search index (the Postgres adapter) reading as the schema owner, which sees every document. */
const searchIndex = () => createPostgresSearchIndex({ inTenant: (_org, fn) => fn({ executeSql: async (text, values) => ({ rows: (await owner.query(text, values as unknown[])).rows }) }) });

/** What the search index holds for the form: the documents as the tsvector text Postgres stores them in, by submission. */
async function searchDocs(formId: string): Promise<Array<{ submission_id: string; doc: string }>> {
  return (await owner.query('select submission_id, doc::text as doc from submission_search where form_id = $1 order by received_at', [formId])).rows;
}

/** The unique-ID answer of every stored response of the form, in the order they were stored. */
async function tickets(formId: string, block = 'ticket'): Promise<string[]> {
  const { rows } = await owner.query<{ ticket: string }>(`select answers -> $2 ->> 'value' as ticket from submissions where form_id = $1 order by seq`, [formId, block]);
  return rows.map((r) => r.ticket);
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_submit_effects');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  await installQueueSchema({ connectionString: urls.fr_migrator, appRole: 'fr_app' });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  appDb = createDb(urls.fr_app, { max: 40, applicationName: 'fr-api-submit-effects-test' });
  dir = await mkdtemp(path.join(tmpdir(), 'fr-submit-effects-'));
  orgId = randomUUID();
  userId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'submit-effects']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@submit-effects.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);
  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, DATABASE_POOL_MAX: '40', AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  edition = runtimeEdition(editionSummary(parsed.config.edition));
  secret = () => parsed.config.auth.secret;
  keyring = parseJobKeyring(`t1:${Buffer.alloc(32, 7).toString('base64url')}`);
  // The composition root's wiring (`main.ts`): a producer queue on the app's own database, and the Postgres search index.
  queue = createPgBossQueue({ connectionString: urls.fr_app, keyring, mode: 'producer', max: 2, applicationName: 'fr-api-queue-test' });
  await queue.start();
  app = await buildApp(parsed.config, {
    underPressure: false,
    files: createFileStore(dir),
    searchIndex: createPostgresSearchIndex,
    queue,
    authLimits: { auth_submit_ip: BUDGET, auth_submit_form: BUDGET, auth_files_ip: BUDGET, auth_files_form: BUDGET },
  });
});

afterAll(async () => {
  await app?.close();
  await queue?.stop({ graceMs: 1000 });
  await appDb?.close();
  await owner?.end();
  await rm(dir, { recursive: true, force: true });
});

describe('the submission.fanout job', () => {
  it('is enqueued exactly once by a committed submit, signed, naming the form, with ids and no answer', async () => {
    const f = await publishBlocks('Fanout', [fieldBlock('name', 'short_text')]);
    const res = await submit(f, { name: short('Asha Rao') });
    expect(res.statusCode, res.body).toBe(200);
    const { submissionId } = res.json<{ submissionId: string }>();
    const jobs = await jobsFor(f.id);
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(job).toMatchObject({ state: 'created', data: { orgId, resource: { type: 'form', id: f.id }, data: { submissionId, event: 'created' } } });
    // The instant is the submission's own (the moment inside its UUIDv7 id).
    const { rows } = await owner.query<{ received_at: Date }>('select received_at from submissions where id = $1', [submissionId]);
    expect(new Date(String(job!.data.data.receivedAt)).getTime()).toBe(rows[0]!.received_at.getTime());
    expect(Object.keys(job!.data.data).sort()).toEqual(['event', 'receivedAt', 'submissionId']);
    expect(JSON.stringify(job!.data)).not.toContain('Asha');
    // The worker accepts it: the envelope verifies under the key ring.
    expect(verifyJob(keyring, 'submission.fanout', job!.data).ok).toBe(true);
  });

  it('is not enqueued a second time by a replay of the Idempotency-Key, which also indexes nothing twice', async () => {
    const f = await publishBlocks('Fanout replay', [fieldBlock('name', 'short_text')]);
    const key = randomUUID();
    const first = await submit(f, { name: short('Asha') }, key);
    const replay = await submit(f, { name: short('Asha') }, key);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(await jobsFor(f.id)).toHaveLength(1);
    expect(await searchDocs(f.id)).toHaveLength(1);
    // The same key with other answers is refused, and enqueues nothing either.
    expect((await submit(f, { name: short('Someone else') }, key)).statusCode).toBe(422);
    expect(await jobsFor(f.id)).toHaveLength(1);
  });

  it('is not enqueued by a request that is refused: invalid answers, a closed form, a form at its limit', async () => {
    const f = await publishBlocks('Fanout refused', [fieldBlock('name', 'short_text', {}, { required: true })]);
    expect((await submit(f, {})).statusCode).toBe(422);
    await setAccess(f.id, { submissionLimit: 1 });
    expect((await submit(f, { name: short('Asha') })).statusCode).toBe(200);
    const refused = await submit(f, { name: short('Ravi') });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'LIMIT_REACHED' });
    expect(await jobsFor(f.id)).toHaveLength(1);
    expect(await searchDocs(f.id)).toHaveLength(1);
  });

  it('is not enqueued, and nothing else is kept, by a submit rolled back by LIMIT_REACHED after its effects ran', async () => {
    const f = await publishBlocks('Fanout rollback', [fieldBlock('name', 'short_text'), uniqueId('ticket')]);
    await setAccess(f.id, { submissionLimit: 1 });
    // A request that read the form while it had room, and whose transaction starts after another response took the last
    // place: the version loader runs between the status check and the transaction, so the test lands that response there.
    const loader = createVersionLoader({ db: appDb.db, edition });
    const lateByOne: VersionLoader = {
      get: async (found, versionId, requestId) => {
        await owner.query('update form_counters set submitted_total = 1 where form_id = $1', [f.id]);
        return loader.get(found, versionId, requestId);
      },
    };
    const request = {
      slug: f.slug,
      requestId: 'fanout-rollback',
      idempotencyKey: randomUUID(),
      accessToken: undefined,
      userAgent: undefined,
      body: { formVersionId: f.versionId, answers: { name: short('Asha') }, locale: 'en-IN', client: undefined },
    };
    await expect(
      submitPipeline({ db: appDb.db, secret: secret(), loader: lateByOne, now: () => new Date(), effects: { searchIndex: createPostgresSearchIndex, queue } }, request),
    ).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
    // The INSERT, the search document, the job, the number and the key all went with the transaction.
    expect(await count('select count(*) as n from submissions where form_id = $1', f.id)).toBe(0);
    expect(await searchDocs(f.id)).toEqual([]);
    expect(await jobsFor(f.id)).toEqual([]);
    expect(await count('select count(*) as n from form_id_counters where form_id = $1', f.id)).toBe(0);
    expect(await count('select count(*) as n from submission_idempotency where form_id = $1', f.id)).toBe(0);
    // The number it took is given back: with room again, the next response is T-001.
    await owner.query('update form_counters set submitted_total = 0 where form_id = $1', [f.id]);
    expect((await submit(f, { name: short('Ravi') })).statusCode).toBe(200);
    expect(await tickets(f.id)).toEqual(['T-001']);
    expect(await jobsFor(f.id)).toHaveLength(1);
  });

  it('is enqueued once for each of many submits at once: one job per stored response, none for the rest', async () => {
    const f = await publishBlocks('Fanout many', [fieldBlock('name', 'short_text')]);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => submit(f, { name: short(`Respondent ${i}`) })));
    expect(results.map((r) => r.statusCode)).toEqual(Array(20).fill(200));
    const ids = results.map((r) => r.json<{ submissionId: string }>().submissionId).sort();
    const jobs = await jobsFor(f.id);
    expect(jobs.map((j) => j.data.data.submissionId as string).sort()).toEqual(ids);
  });
});

describe('the search document', () => {
  it('holds a plain answer’s text and neither an encrypt or sensitive field nor a value derived from one', async () => {
    const f = await publishBlocks('Search doc', [
      fieldBlock('name', 'short_text'),
      sensitive(fieldBlock('pan', 'short_text')),
      encrypted(fieldBlock('phone', 'short_text')),
      fieldBlock('qty', 'number'),
      fieldBlock('price', 'number'),
      sensitive(fieldBlock('income', 'number')),
      calculation('total', times('qty', 'price')),
      calculation('tax', times('income', 'qty')),
    ]);
    const res = await submit(f, {
      name: short('Asha Rao'),
      pan: short('ABCDE1234F'),
      phone: short('9876543210'),
      qty: num('7'),
      price: num('1111'),
      income: num('424242'),
    });
    expect(res.statusCode, res.body).toBe(200);
    const docs = await searchDocs(f.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.submission_id).toBe(res.json<{ submissionId: string }>().submissionId);
    // The plain answers and the calculation of plain answers (7 x 1111) are in it ...
    expect(docs[0]!.doc).toMatch(/'asha'/);
    expect(docs[0]!.doc).toMatch(/'rao'/);
    expect(docs[0]!.doc).toMatch(/'7777'/);
    // ... the encrypt and sensitive fields, and the variable derived from the sensitive income (424242 x 7), are not.
    for (const secretText of ['abcde1234f', '9876543210', '424242', '2969694']) expect(docs[0]!.doc, secretText).not.toContain(secretText);
    // The stored answers still hold them (plain until WP-1.11 encrypts them); only the index does not.
    const stored = (await owner.query('select answers from submissions where form_id = $1', [f.id])).rows[0].answers as Record<string, { value: unknown }>;
    expect(stored.pan?.value).toBe('ABCDE1234F');
    // And the index finds a word of the plain answers, within the form, and nothing for a sensitive one.
    expect((await searchIndex().query(orgId, { formId: f.id, text: 'asha', limit: 10 })).hits).toHaveLength(1);
    expect((await searchIndex().query(orgId, { formId: f.id, text: 'ABCDE1234F', limit: 10 })).hits).toHaveLength(0);
  });

  it('is written for a response with no searchable text at all, and in the same transaction as the response', async () => {
    const f = await publishBlocks('Search sensitive only', [sensitive(fieldBlock('pan', 'short_text'))]);
    const res = await submit(f, { pan: short('ABCDE1234F') });
    expect(res.statusCode, res.body).toBe(200);
    expect(await searchDocs(f.id)).toEqual([{ submission_id: res.json<{ submissionId: string }>().submissionId, doc: '' }]);
  });
});

describe('unique-ID counters', () => {
  it('give 20 concurrent submits the numbers 1 to 20 with no gap and no repeat', async () => {
    const f = await publishBlocks('Tickets', [fieldBlock('name', 'short_text'), uniqueId('ticket')]);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => submit(f, { name: short(`Respondent ${i}`) })));
    expect(results.map((r) => r.statusCode)).toEqual(Array(20).fill(200));
    const numbers = (await tickets(f.id)).map((t) => Number(t.replace('T-', ''))).sort((x, y) => x - y);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await tickets(f.id)).toContain('T-001');
    // The counter row is the next number, and one row serves the form.
    expect((await owner.query('select block_id, period, next_seq::int as next_seq from form_id_counters where form_id = $1', [f.id])).rows).toEqual([{ block_id: 'ticket', period: '', next_seq: 21 }]);
    // The number is in the search document too, so a response can be found by its ticket.
    const hits = (await searchIndex().query(orgId, { formId: f.id, text: 'T-007', limit: 10 })).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.submissionId).toBe((await owner.query(`select id from submissions where form_id = $1 and answers -> 'ticket' ->> 'value' = 'T-007'`, [f.id])).rows[0].id);
  });

  it('stay gap-free when most of 20 racing submits are turned away at the limit: only committed responses hold numbers', async () => {
    const f = await publishBlocks('Tickets limit', [fieldBlock('name', 'short_text'), uniqueId('ticket')]);
    await setAccess(f.id, { submissionLimit: 12 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => submit(f, { name: short(`Respondent ${i}`) })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(12);
    expect(results.filter((r) => r.statusCode === 409).map((r) => r.json<{ code: string }>().code)).toEqual(Array(8).fill('LIMIT_REACHED'));
    const numbers = (await tickets(f.id)).map((t) => Number(t.replace('T-', ''))).sort((x, y) => x - y);
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect((await owner.query('select next_seq::int as next_seq from form_id_counters where form_id = $1', [f.id])).rows).toEqual([{ next_seq: 13 }]);
    expect(await jobsFor(f.id)).toHaveLength(12);
  });

  it('are the server’s: a number sent by the page is replaced, and a block the path did not reach takes none', async () => {
    const f = await publishBlocks('Tickets hidden', [fieldBlock('name', 'short_text'), uniqueId('ticket')], [hideWhenSkip('name', ['ticket'])]);
    const forged = await submit(f, { name: short('Asha'), ticket: { type: 'unique_id', value: 'T-999' } });
    expect(forged.statusCode, forged.body).toBe(200);
    // A response whose rule hides the ticket has no ticket and uses no number.
    const hidden = await submit(f, { name: short('skip'), ticket: { type: 'unique_id', value: 'T-998' } });
    expect(hidden.statusCode, hidden.body).toBe(200);
    const next = await submit(f, { name: short('Ravi') });
    expect(next.statusCode).toBe(200);
    expect(await tickets(f.id)).toEqual(['T-001', null, 'T-002']);
    expect((await owner.query('select next_seq::int as next_seq from form_id_counters where form_id = $1', [f.id])).rows).toEqual([{ next_seq: 3 }]);
  });

  it('start at startAt, carry a prefix and padding, and count a form’s blocks separately', async () => {
    const f = await publishBlocks('Tickets two blocks', [
      fieldBlock('name', 'short_text'),
      uniqueId('ticket', { prefix: ['APP-'], padTo: 4, startAt: 100 }),
      uniqueId('receipt', { prefix: [], padTo: 2, startAt: 1 }),
    ]);
    for (let i = 0; i < 2; i++) expect((await submit(f, { name: short(`R${i}`) })).statusCode).toBe(200);
    expect(await tickets(f.id, 'ticket')).toEqual(['APP-0100', 'APP-0101']);
    expect(await tickets(f.id, 'receipt')).toEqual(['01', '02']);
  });

  it('are returned to the respondent for the ending: only the shown numbers, and the same ones on a replay with no new number taken', async () => {
    const f = await publishBlocks('Tickets shown', [fieldBlock('name', 'short_text'), uniqueId('ticket'), uniqueId('receipt', { showOnEnding: false })]);
    const key = randomUUID();
    const first = await submit(f, { name: short('Asha') }, key);
    expect(first.statusCode, first.body).toBe(200);
    // The ticket is shown; the receipt number is not marked and no ending pipes it; the answers themselves never come back.
    expect(first.json()).toEqual({ ok: true, submissionId: expect.any(String), endingId: 'end_1', uniqueId: 'T-001', uniqueIds: { ticket: 'T-001' } });
    const replay = await submit(f, { name: short('Asha') }, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(await tickets(f.id)).toEqual(['T-001']);
    expect((await owner.query('select next_seq::int as next_seq from form_id_counters where form_id = $1 and block_id = $2', [f.id, 'ticket'])).rows).toEqual([{ next_seq: 2 }]);
    // The next submission is numbered on from there.
    expect((await submit(f, { name: short('Ravi') })).json()).toMatchObject({ uniqueId: 'T-002' });
  });

  it('give 8 concurrent retries of one key the same number, and burn none', async () => {
    const f = await publishBlocks('Tickets retry race', [fieldBlock('name', 'short_text'), uniqueId('ticket')]);
    const key = randomUUID();
    const all = await Promise.all(Array.from({ length: 8 }, () => submit(f, { name: short('Asha') }, key)));
    expect(all.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    expect(new Set(all.map((r) => r.json<{ uniqueId: string }>().uniqueId))).toEqual(new Set(['T-001']));
    expect(await tickets(f.id)).toEqual(['T-001']);
    expect((await submit(f, { name: short('Ravi') })).json()).toMatchObject({ uniqueId: 'T-002' });
  });

  it('are not returned for a number the path did not reach', async () => {
    const f = await publishBlocks('Tickets hidden shown', [fieldBlock('name', 'short_text'), uniqueId('ticket')], [hideWhenSkip('name', ['ticket'])]);
    const res = await submit(f, { name: short('skip') });
    expect(res.json()).toEqual({ ok: true, submissionId: expect.any(String), endingId: 'end_1' });
  });

  it('can be advanced only by a respondent or system context: a member cannot move a counter (the table’s RLS holds)', async () => {
    const f = await publishBlocks('Tickets RLS', [uniqueId('ticket')]);
    expect((await submit(f, {})).statusCode).toBe(200);
    const advance = (actor: 'user' | 'system' | 'respondent') =>
      withTenant(appDb.db, { orgId, actor, requestId: 'counter-rls', ...(actor === 'user' ? { userId, perms: ['forms.edit'] } : {}) }, (tx) =>
        tx.execute(sql`update form_id_counters set next_seq = next_seq + 1 where form_id = ${f.id}`),
      ).then(
        (r) => r.rowCount,
        (e: { code?: string }) => e.code ?? 'error',
      );
    expect(await advance('user')).toBe(0);
    expect(await advance('respondent')).toBe(1);
    expect(await advance('system')).toBe(1);
  });
});
