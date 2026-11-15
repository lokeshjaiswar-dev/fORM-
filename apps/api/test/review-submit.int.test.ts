import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPgBossQueue, installQueueSchema, parseJobKeyring, type PgBossQueue } from '@form/adapters/queue';
import { createPostgresSearchIndex } from '@form/adapters/search';
import { provision } from '@form/db';
import { sha256Jcs, type FormDefinition } from '@form/schema';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { createFileStore } from '../src/files.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

/*
 * WP-2.33 at submit: a form with review holds the response as `pending_review` and opens its review in the submit
 * transaction. What is stored (the status, one row per unit with the hash of that unit's answers, who is excluded
 * from checking), what is not sent (no submission.fanout job, no search document missing), what the respondent is told
 * (`held`, also on a replay), and that a form whose required units do not apply to the answers is as before.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
/** More than any test sends from one address, so the throttle never speaks. */
const BUDGET = { max: 100_000, windowSeconds: 600 };

let app: FastifyInstance;
let owner: pg.Pool;
let queue: PgBossQueue;
let dir: string;
let orgId: string;
let ownerId: string;
let groupA: string;
let groupB: string;
/** A member whose verified address is the one the respondent types, one whose verified address is the backup one, and one with neither. */
const member = { matching: randomUUID(), backup: randomUUID(), bystander: randomUUID(), unverified: randomUUID() };
const RESPONDENT = 'asha.rao@respondent.test';
const BACKUP = 'asha.backup@respondent.test';

const as = () => ({ 'x-fr-dev-user': ownerId, 'x-fr-org': orgId, ...BROWSER });
const short = (value: string) => ({ type: 'short_text', value });
const mail = (address: string) => ({ type: 'email', value: { address } });

interface Published {
  id: string;
  slug: string;
  versionId: string;
}

/**
 * Two page units. Page 1 holds the applicant's name, two addresses and (when asked) a unique ID; page 2 holds a note and is
 * hidden when the name is "skip". `u_applicant` covers page 1 and `u_notes` page 2.
 */
function reviewedDraft(formId: string, title: string, o: { uniqueId?: boolean; units?: boolean } = {}): FormDefinition {
  const page1 = ['name', 'email', 'backup', ...(o.uniqueId ? ['ticket'] : [])];
  const blocks = [
    fieldBlock('name', 'short_text'),
    fieldBlock('email', 'email'),
    fieldBlock('backup', 'email'),
    ...(o.uniqueId ? [{ ...fieldBlock('ticket', 'short_text'), type: 'unique_id', config: { prefix: ['T-'], padTo: 3, startAt: 1, resetEvery: 'never', showOnEnding: false } } as unknown as ReturnType<typeof fieldBlock>] : []),
    fieldBlock('note', 'short_text'),
  ];
  const base = draftWith(formId, blocks, title);
  const skip = {
    id: 'rule_skip',
    enabled: true,
    when: {
      kind: 'group',
      id: 'group_1',
      combinator: 'all',
      children: [{ kind: 'condition', id: 'cond_1', left: { kind: 'ref', ref: { kind: 'answer', blockId: 'name' } }, op: 'eq', right: { kind: 'literal', value: { type: 'text', value: 'skip' } } }],
    },
    then: [{ type: 'hide', targets: ['page_2'] }],
  };
  return {
    ...base,
    pages: [
      { ...base.pages[0]!, children: page1 },
      { id: 'page_2', children: ['note'] },
    ],
    logic: { ...base.logic, rules: [skip] },
    ...(o.units === false
      ? {}
      : {
          review: {
            units: [
              { id: 'u_applicant', name: 'Applicant', target: { kind: 'page', pageId: 'page_1' } },
              { id: 'u_notes', name: 'Notes', target: { kind: 'page', pageId: 'page_2' } },
            ],
          },
        }),
  } as unknown as FormDefinition;
}

async function publishDraft(title: string, make: (formId: string) => FormDefinition): Promise<Published> {
  const { id } = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(), payload: { title } })).json<{ id: string }>();
  const put = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...as(), 'if-match': '0' }, payload: { draft: make(id) } });
  expect(put.statusCode, put.body).toBe(200);
  const live = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(), payload: {} });
  expect(live.statusCode, live.body).toBe(200);
  return { id, ...live.json<{ slug: string; versionId: string }>() };
}

interface Assignment {
  unitId: string;
  groupId: string;
  order: number;
  required: boolean;
  visibility: 'own_unit' | 'whole_submission';
}
const assign = (unitId: string, o: Partial<Assignment> = {}): Assignment => ({ unitId, groupId: groupA, order: 1, required: true, visibility: 'own_unit', ...o });

async function setReview(formId: string, units: Assignment[], enabled = true): Promise<void> {
  const res = await app.inject({ method: 'PUT', url: `/v1/forms/${formId}/review`, headers: { ...as(), 'if-match': '0' }, payload: { enabled, distinctCheckers: false, units } });
  expect(res.statusCode, res.body).toBe(200);
}

/** A form with both units published, and its review assigned as given (both required, in two groups, unless told otherwise). */
async function reviewedForm(title: string, units: Assignment[] = [assign('u_applicant'), assign('u_notes', { groupId: groupB, order: 2 })], o: { uniqueId?: boolean } = {}): Promise<Published> {
  const form = await publishDraft(title, (id) => reviewedDraft(id, title, o));
  await setReview(form.id, units);
  return form;
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

const answersOf = (o: { name?: string; note?: string | null } = {}) => ({
  name: short(o.name ?? 'Asha Rao'),
  email: mail(RESPONDENT),
  backup: mail(BACKUP),
  ...(o.note === null ? {} : { note: short(o.note ?? 'Needs a ground floor room') }),
});

/** A respondent's POST; every call is a new submission (a fresh Idempotency-Key) unless `key` says otherwise. */
const submit = (f: Published, answers: Record<string, unknown>, key: string = randomUUID()) =>
  app.inject({
    method: 'POST',
    url: `/v1/p/${f.slug}/submissions`,
    headers: { 'idempotency-key': key },
    payload: { formVersionId: f.versionId, answers, fields: [], locale: 'en-IN' },
  });

interface StoredSubmission {
  status: string;
  answers: Record<string, unknown>;
  form_version_id: string;
}
const stored = async (submissionId: string): Promise<StoredSubmission> =>
  (await owner.query<StoredSubmission>('select status, answers, form_version_id from submissions where id = $1', [submissionId])).rows[0]!;

interface ReviewRow {
  unit_id: string;
  round: number;
  state: string;
  required: boolean;
  review_order: number;
  group_id: string;
  visibility: string;
  maker_user_id: string | null;
  excluded_user_ids: string[];
  hash: string;
}
const reviewRows = async (submissionId: string): Promise<ReviewRow[]> =>
  (
    await owner.query<ReviewRow>(
      `select unit_id, round, state, required, review_order, group_id, visibility, maker_user_id, excluded_user_ids, encode(answers_hash, 'hex') as hash
       from submission_reviews where submission_id = $1 order by unit_id`,
      [submissionId],
    )
  ).rows;

/** The unit's answers as `review_decide()` will be asked to match: JCS of the stored answers of its blocks that have one. */
const unitHash = (answers: Record<string, unknown>, blocks: string[]): string => sha256Jcs(Object.fromEntries(blocks.filter((b) => answers[b] !== undefined).map((b) => [b, answers[b]])));

const fanoutJobs = async (formId: string): Promise<Array<{ id: string; data: { data: Record<string, unknown> } }>> =>
  (await owner.query(`select id, data from pgboss.job where name = 'submission.fanout' and data -> 'resource' ->> 'id' = $1 order by created_on`, [formId])).rows;

const count = async (text: string, ...params: unknown[]): Promise<number> => Number((await owner.query(text, params)).rows[0].n);

const openedEvents = async (formId: string): Promise<Array<Record<string, unknown>>> =>
  (await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'action' = 'review.opened' and event->>'formId' = $2 order by id`, [orgId, formId])).rows.map((r) => r.event);

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_review_submit');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  await installQueueSchema({ connectionString: urls.fr_migrator, appRole: 'fr_app' });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  dir = await mkdtemp(path.join(tmpdir(), 'fr-review-submit-'));
  orgId = randomUUID();
  ownerId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'review-submit']);
  const people: Array<{ id: string; role: string; email: string; verified: boolean }> = [
    { id: ownerId, role: 'owner', email: 'owner@review-submit.test', verified: true },
    { id: member.matching, role: 'editor', email: RESPONDENT, verified: true },
    { id: member.backup, role: 'editor', email: BACKUP, verified: true },
    { id: member.bystander, role: 'editor', email: 'someone.else@review-submit.test', verified: true },
    { id: member.unverified, role: 'editor', email: 'unverified@review-submit.test', verified: false },
  ];
  for (const p of people) {
    await owner.query(`insert into users (id, email, email_norm, email_verified_at) values ($1, $2, $2, ${p.verified ? 'now()' : 'null'})`, [p.id, p.email]);
    await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, p.id, p.role]);
  }
  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  const keyring = parseJobKeyring(`t1:${Buffer.alloc(32, 7).toString('base64url')}`);
  // The composition root's wiring (`main.ts`): a producer queue on the app's own database, and the Postgres search index.
  queue = createPgBossQueue({ connectionString: urls.fr_app, keyring, mode: 'producer', max: 2, applicationName: 'fr-api-review-submit-test' });
  await queue.start();
  app = await buildApp(parsed.config, {
    underPressure: false,
    files: createFileStore(dir),
    searchIndex: createPostgresSearchIndex,
    queue,
    authLimits: { auth_submit_ip: BUDGET, auth_submit_form: BUDGET, auth_files_ip: BUDGET, auth_files_form: BUDGET },
  });
  for (const name of ['Group A', 'Group B']) {
    const res = await app.inject({ method: 'POST', url: '/v1/org/review-groups', headers: as(), payload: { name } });
    expect(res.statusCode, res.body).toBe(201);
    if (name === 'Group A') groupA = res.json<{ id: string }>().id;
    else groupB = res.json<{ id: string }>().id;
  }
});

afterAll(async () => {
  await app?.close();
  await queue?.stop({ graceMs: 1000 });
  await owner?.end();
  await rm(dir, { recursive: true, force: true });
});

describe('a submit to a form with review on', () => {
  it('stores the response pending_review, one review row per unit with the hash of its answers, and review.opened; no fan-out job, and the respondent is told it is held', async () => {
    const f = await reviewedForm('Held');
    const res = await submit(f, answersOf());
    expect(res.statusCode, res.body).toBe(200);
    const { submissionId, held } = res.json<{ submissionId: string; held?: string }>();
    expect(held).toBe('pending_review');

    const row = await stored(submissionId);
    expect(row.status).toBe('pending_review');
    expect(row.form_version_id).toBe(f.versionId);
    const reviews = await reviewRows(submissionId);
    expect(reviews.map((r) => [r.unit_id, r.state, r.round, r.required, r.review_order, r.group_id, r.visibility])).toEqual([
      ['u_applicant', 'pending', 1, true, 1, groupA, 'own_unit'],
      ['u_notes', 'pending', 1, true, 2, groupB, 'own_unit'],
    ]);
    // The hash a decision must name: the stored answers of the unit's own blocks, and of no other.
    expect(reviews[0]!.hash).toBe(unitHash(row.answers, ['name', 'email', 'backup']));
    expect(reviews[1]!.hash).toBe(unitHash(row.answers, ['note']));
    expect(reviews[0]!.hash).not.toBe(reviews[1]!.hash);
    // A public respondent makes no maker: the four-eyes rule of this slice rests on the address match.
    expect(reviews.every((r) => r.maker_user_id === null)).toBe(true);

    // review.opened in the same transaction: counts and ids, never an answer or an address.
    const events = await openedEvents(f.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorKind: 'respondent', resourceType: 'submission', resourceId: submissionId, formId: f.id, outcome: 'success', metadata: { units: 2, pending: 2, excluded: 2 } });
    expect(JSON.stringify(events[0])).not.toContain('respondent.test');
    expect(JSON.stringify(events[0])).not.toContain('Asha');

    // Nothing leaves while it is held, but it counts and can be found.
    expect(await fanoutJobs(f.id)).toEqual([]);
    expect(await count('select submitted_total as n from form_counters where form_id = $1', f.id)).toBe(1);
    expect(await count('select count(*) as n from submission_search where form_id = $1 and submission_id = $2', f.id, submissionId)).toBe(1);
  });

  it('keeps the unit hash of numbered answers: a unique ID in a unit is hashed with the number it was given', async () => {
    const f = await reviewedForm('Held numbered', undefined, { uniqueId: true });
    const first = (await submit(f, answersOf())).json<{ submissionId: string }>();
    const second = (await submit(f, answersOf())).json<{ submissionId: string }>();
    for (const [i, { submissionId }] of [first, second].entries()) {
      const row = await stored(submissionId);
      expect((row.answers['ticket'] as { value: string }).value).toBe(`T-00${i + 1}`);
      const [applicant] = await reviewRows(submissionId);
      expect(applicant!.hash).toBe(unitHash(row.answers, ['name', 'email', 'backup', 'ticket']));
    }
  });

  it('stores a unit whose blocks are hidden by logic as not_applicable, and still holds for the others', async () => {
    const f = await reviewedForm('Held partly');
    const res = await submit(f, answersOf({ name: 'skip', note: null }));
    expect(res.statusCode, res.body).toBe(200);
    const { submissionId, held } = res.json<{ submissionId: string; held?: string }>();
    expect(held).toBe('pending_review');
    const reviews = await reviewRows(submissionId);
    expect(reviews.map((r) => [r.unit_id, r.state])).toEqual([
      ['u_applicant', 'pending'],
      ['u_notes', 'not_applicable'],
    ]);
    // A unit with nothing to review hashes the empty set of answers.
    expect(reviews[1]!.hash).toBe(sha256Jcs({}));
    expect(await fanoutJobs(f.id)).toEqual([]);
    expect(await openedEvents(f.id)).toEqual([expect.objectContaining({ metadata: { units: 2, pending: 1, excluded: 2 } })]);
  });

  it('stores the response complete, with its one fan-out job, when every required unit is not applicable', async () => {
    // Only the notes unit is required; hiding its page leaves nothing a checker must approve (the applicant's unit is not assigned).
    const f = await reviewedForm('Not applicable', [assign('u_notes', { groupId: groupB })]);
    const res = await submit(f, answersOf({ name: 'skip', note: null }));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ submissionId: string; held?: string }>();
    expect(body.held).toBeUndefined();
    expect((await stored(body.submissionId)).status).toBe('complete');
    expect(await reviewRows(body.submissionId)).toEqual([]);
    expect(await openedEvents(f.id)).toEqual([]);
    const jobs = await fanoutJobs(f.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data.data).toMatchObject({ submissionId: body.submissionId, event: 'created' });

    // The same form with the note shown asks for a checker.
    const shown = await submit(f, answersOf());
    expect(shown.json()).toMatchObject({ held: 'pending_review' });
  });

  it('is not held when the required unit is optional in the settings: only a required, applicable unit holds', async () => {
    const f = await reviewedForm('Optional', [assign('u_applicant', { required: false }), assign('u_notes', { groupId: groupB, order: 2 })]);
    const res = await submit(f, answersOf({ name: 'skip', note: null }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().held).toBeUndefined();
    expect(await fanoutJobs(f.id)).toHaveLength(1);
  });

  it('is as before with review disabled, with no settings row, and with settings that name no unit of this version', async () => {
    const off = await reviewedForm('Review off', [assign('u_applicant')]);
    await owner.query('update form_review_settings set enabled = false where form_id = $1', [off.id]);
    const none = await publishDraft('No settings', (id) => reviewedDraft(id, 'No settings'));
    // A version published without units, whose form still has settings that name one (the units were removed later).
    const dropped = await publishDraft('Dropped units', (id) => reviewedDraft(id, 'Dropped units', { units: false }));
    await owner.query(
      `insert into form_review_settings (form_id, org_id, enabled, settings) values ($1, $2, true, $3::jsonb)`,
      [dropped.id, orgId, JSON.stringify({ enabled: true, distinctCheckers: false, units: [assign('u_applicant')] })],
    );
    for (const f of [off, none, dropped]) {
      const res = await submit(f, answersOf());
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ submissionId: string; held?: string }>();
      expect(body.held, f.slug).toBeUndefined();
      expect((await stored(body.submissionId)).status).toBe('complete');
      expect(await reviewRows(body.submissionId)).toEqual([]);
      expect(await fanoutJobs(f.id)).toHaveLength(1);
    }
  });

  it('excludes the members whose verified address is any address the respondent gave, from checking this response', async () => {
    const f = await reviewedForm('Held excluded');
    const { submissionId } = (await submit(f, answersOf())).json<{ submissionId: string }>();
    const reviews = await reviewRows(submissionId);
    expect(reviews).toHaveLength(2);
    for (const r of reviews) {
      // The address in the email field and the one in the backup field both count; the bystander and the unverified member do not.
      expect([...r.excluded_user_ids].sort()).toEqual([member.matching, member.backup].sort());
      expect(r.excluded_user_ids).not.toContain(member.bystander);
      expect(r.excluded_user_ids).not.toContain(member.unverified);
    }
  });

  it('counts a held response against the limit, and refuses the next one with nothing stored', async () => {
    const f = await reviewedForm('Held limit');
    await setAccess(f.id, { submissionLimit: 1 });
    expect((await submit(f, answersOf())).statusCode).toBe(200);
    const refused = await submit(f, answersOf());
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'LIMIT_REACHED' });
    expect(await count('select count(*) as n from submissions where form_id = $1', f.id)).toBe(1);
    expect(await count('select count(*) as n from submission_reviews where form_id = $1', f.id)).toBe(2);
    expect(await openedEvents(f.id)).toHaveLength(1);
  });
});

describe('a replay of a held submit', () => {
  it('says held again, opens nothing twice and sends nothing', async () => {
    const f = await reviewedForm('Held replay');
    const key = randomUUID();
    const first = await submit(f, answersOf(), key);
    const replay = await submit(f, answersOf(), key);
    expect(first.statusCode, first.body).toBe(200);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(first.json()).toMatchObject({ held: 'pending_review' });
    expect(replay.json()).toEqual(first.json());

    const { submissionId } = first.json<{ submissionId: string }>();
    expect(await count('select count(*) as n from submissions where form_id = $1', f.id)).toBe(1);
    expect(await reviewRows(submissionId)).toHaveLength(2);
    expect(await openedEvents(f.id)).toHaveLength(1);
    expect(await fanoutJobs(f.id)).toEqual([]);
    expect(await count('select submitted_total as n from form_counters where form_id = $1', f.id)).toBe(1);
  });

  it('says held to a double tap too: two requests with one key in flight give one held response and the same answer', async () => {
    const f = await reviewedForm('Held double tap');
    const key = randomUUID();
    const [a, b] = await Promise.all([submit(f, answersOf(), key), submit(f, answersOf(), key)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json()).toMatchObject({ held: 'pending_review' });
    expect(b.json()).toEqual(a.json());
    expect(await count('select count(*) as n from submissions where form_id = $1', f.id)).toBe(1);
    expect(await count('select count(*) as n from submission_reviews where form_id = $1', f.id)).toBe(2);
    expect(await openedEvents(f.id)).toHaveLength(1);
    expect(await fanoutJobs(f.id)).toEqual([]);
  });

  it('says nothing about review for a response that was not held, and the same key with other answers is still refused', async () => {
    const f = await reviewedForm('Complete replay', [assign('u_notes', { groupId: groupB })]);
    const key = randomUUID();
    const first = await submit(f, answersOf({ name: 'skip', note: null }), key);
    const replay = await submit(f, answersOf({ name: 'skip', note: null }), key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(replay.json().held).toBeUndefined();
    expect((await submit(f, answersOf({ name: 'Someone else', note: null }), key)).statusCode).toBe(422);
    expect(await fanoutJobs(f.id)).toHaveLength(1);
  });
});
