import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPgBossQueue, installQueueSchema, parseJobKeyring, verifyJob, type JobKeyring, type PgBossQueue } from '@form/adapters/queue';
import { provision, type MembershipRole } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig, type ApiConfig } from '../src/config.ts';
import { createFileStore } from '../src/files.ts';
import { MAX_ACTIVE, MAX_PER_DAY, MAX_SELECTED } from '../src/routes/exports.ts';
import { createFakeStorage } from './fake-storage.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

/*
 * WP-1.17, the API side: asking for an export, its state and its download. The file itself is the worker's (`export.build`
 * is only enqueued here, through the real pg-boss producer); a test that needs a finished export plays the worker by
 * updating the row as the migrator and putting the object in a fake store. Who may ask, the transaction that writes the
 * row, the audit record and the job together, the Idempotency-Key, the quotas, the states of a download, and that an
 * export is its requester's alone.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;

let app: FastifyInstance;
/** The same API without an object store and a queue, and with a store but no queue: what a deployment that has not set them up answers. */
let bare: FastifyInstance;
let noQueue: FastifyInstance;
let owner: pg.Pool;
let queue: PgBossQueue;
let keyring: JobKeyring;
let config: ApiConfig;
let dir: string;
const storage = createFakeStorage();

interface Org {
  orgId: string;
  formId: string;
  owner: string;
  editor: string;
  /** A second editor: an export is its requester's, so what one asked for is not the other's. */
  editor2: string;
  viewer: string;
  dataViewer: string;
}

let a: Org;
let b: Org;

const as = (userId: string, orgId: string) => ({ 'x-fr-dev-user': userId, 'x-fr-org': orgId, ...BROWSER });

async function newUser(label: string): Promise<string> {
  const id = randomUUID();
  await owner.query('insert into users (id, email, email_norm, name, email_verified_at) values ($1, $2, $2, $3, now())', [id, `${label}-${id.slice(0, 8)}@exports.test`, label]);
  return id;
}

async function newOrg(slug: string): Promise<Org> {
  const orgId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, slug]);
  const member = async (label: string, role: MembershipRole) => {
    const id = await newUser(`${slug}-${label}`);
    await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, id, role]);
    return id;
  };
  const ownerId = await member('owner', 'owner');
  const org = {
    orgId,
    owner: ownerId,
    editor: await member('editor', 'editor'),
    editor2: await member('editor2', 'editor'),
    viewer: await member('viewer', 'viewer'),
    dataViewer: await member('dataviewer', 'data_viewer'),
  };
  const created = await app.inject({ method: 'POST', url: '/v1/forms', headers: as(ownerId, orgId), payload: { title: `Intake ${slug} नमस्ते` } });
  expect(created.statusCode, created.body).toBe(200);
  return { ...org, formId: created.json<{ id: string }>().id };
}

interface Sent {
  format?: string;
  scope?: unknown;
  includeSensitive?: boolean;
  reason?: string;
}

/** POST /v1/forms/:formId/exports as `userId` in `org`; a fresh Idempotency-Key unless `key` says otherwise (null sends none). */
function ask(org: Org, userId: string, body: Sent = {}, key: string | null = randomUUID(), formId = org.formId, instance: FastifyInstance = app) {
  return instance.inject({
    method: 'POST',
    url: `/v1/forms/${formId}/exports`,
    headers: { ...as(userId, org.orgId), ...(key === null ? {} : { 'idempotency-key': key }) },
    payload: { format: 'csv', scope: { kind: 'all' }, ...body } as Record<string, unknown>,
  });
}

const status = (org: Org, userId: string, id: string, instance: FastifyInstance = app) =>
  instance.inject({ method: 'GET', url: `/v1/exports/${id}`, headers: as(userId, org.orgId) });
const download = (org: Org, userId: string, id: string, instance: FastifyInstance = app) =>
  instance.inject({ method: 'GET', url: `/v1/exports/${id}/download`, headers: as(userId, org.orgId) });

interface ExportRow {
  id: string;
  org_id: string;
  form_id: string;
  requested_by: string;
  format: string;
  scope: Record<string, unknown>;
  include_sensitive: boolean;
  reason: string | null;
  idempotency_key: string;
  status: string;
  object_key: string | null;
}

const rowOf = async (id: string): Promise<ExportRow | undefined> => (await owner.query<ExportRow>('select * from exports where id = $1', [id])).rows[0];
const exportsOf = async (orgId: string): Promise<number> => Number((await owner.query('select count(*) as n from exports where org_id = $1', [orgId])).rows[0].n);

interface JobRow {
  id: string;
  state: string;
  data: { orgId: string; resource: { type: string; id: string }; data: Record<string, unknown> };
}
const jobsFor = async (exportId: string): Promise<JobRow[]> =>
  (await owner.query<JobRow>(`select id, state, data from pgboss.job where name = 'export.build' and data -> 'resource' ->> 'id' = $1`, [exportId])).rows;

/** The audit events a request left, by its id (`audit_pending` holds them until `audit.chain` runs). */
async function auditOf(res: { headers: Record<string, unknown> }, orgKey: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'requestId' = $2 order by id`, [orgKey, res.headers['x-request-id']]);
  return rows.map((r) => r.event);
}

/** Plays the worker: the export is built, its file is in the store, and it is kept for an hour. */
async function finish(id: string, bytes: Uint8Array | string, o: { expiresIn?: string; put?: boolean } = {}): Promise<string> {
  const row = (await rowOf(id))!;
  const key = `${row.org_id}/${id}.${row.format}`;
  const length = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
  if (o.put !== false) storage.seed('exports', key, bytes);
  await owner.query(
    `update exports set status = 'ready', row_count = 3, object_key = $2, bytes = $3, finished_at = now(), expires_at = now() + $4::interval where id = $1`,
    [id, key, length, o.expiresIn ?? '1 hour'],
  );
  return key;
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_exports');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  await installQueueSchema({ connectionString: urls.fr_migrator, appRole: 'fr_app' });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 3 });
  dir = await mkdtemp(path.join(tmpdir(), 'fr-exports-'));
  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, DATABASE_POOL_MAX: '40', AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  config = parsed.config;
  keyring = parseJobKeyring(`t1:${Buffer.alloc(32, 9).toString('base64url')}`);
  queue = createPgBossQueue({ connectionString: urls.fr_app, keyring, mode: 'producer', max: 4, applicationName: 'fr-api-exports-test' });
  await queue.start();
  app = await buildApp(config, { underPressure: false, files: createFileStore(dir), queue, storage });
  bare = await buildApp(config, { underPressure: false, files: createFileStore(dir) });
  noQueue = await buildApp(config, { underPressure: false, files: createFileStore(dir), storage });
  a = await newOrg('exports-a');
  b = await newOrg('exports-b');
});

/**
 * The quota of ten queued or running exports is a test's subject of its own (below, in orgs of their own). The tests that
 * only need an export to exist leave theirs queued, so each test starts from an org with none in progress.
 */
afterEach(async () => {
  await owner.query(`update exports set status = 'failed', error = 'left queued by a test' where org_id = any($1) and status in ('queued', 'running')`, [[a.orgId, b.orgId]]);
});

afterAll(async () => {
  await app?.close();
  await bare?.close();
  await noQueue?.close();
  await queue?.stop({ graceMs: 1000 });
  await owner?.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('who may ask for an export', () => {
  it('refuses a data viewer, and a viewer, on every route with 403 and an audit record, and writes nothing', async () => {
    const before = await exportsOf(a.orgId);
    for (const who of [a.dataViewer, a.viewer]) {
      const res = await ask(a, who);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
      expect(await auditOf(res, a.orgId)).toEqual([expect.objectContaining({ action: 'request.authorize', outcome: 'denied', reason: 'missing_permission:submissions.export', actorId: who })]);
      const state = await status(a, who, randomUUID());
      expect(state.statusCode).toBe(403);
      const file = await download(a, who, randomUUID());
      expect(file.statusCode, file.body).toBe(403);
      expect(await auditOf(file, a.orgId)).toEqual([expect.objectContaining({ action: 'request.authorize', outcome: 'denied', actorId: who })]);
    }
    expect(await exportsOf(a.orgId)).toBe(before);
  });

  it('refuses a data viewer the download of an export that exists (the file is not even read)', async () => {
    const made = await ask(a, a.editor);
    const id = made.json<{ id: string }>().id;
    await finish(id, 'private,rows\n');
    const reads = storage.reads.length;
    const res = await download(a, a.dataViewer, id);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('private');
    expect(storage.reads).toHaveLength(reads);
  });

  it('lets an editor ask: 200, one exports row, one submission.exported record and one signed export.build job, in one transaction', async () => {
    const key = randomUUID();
    const res = await ask(a, a.editor, { format: 'xlsx', scope: { kind: 'all' } }, key);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    const view = res.json<Record<string, unknown>>();
    expect(view).toMatchObject({ formId: a.formId, format: 'xlsx', scope: { kind: 'all' }, includeSensitive: false, status: 'queued', rowCount: null, bytes: null, error: null, finishedAt: null, expiresAt: null });
    expect(view).not.toHaveProperty('objectKey');
    expect(view).not.toHaveProperty('reason');

    const id = view.id as string;
    expect(await rowOf(id)).toMatchObject({ org_id: a.orgId, form_id: a.formId, requested_by: a.editor, format: 'xlsx', scope: { kind: 'all' }, include_sensitive: false, reason: null, idempotency_key: key, status: 'queued', object_key: null });

    // The audit record is the request's, in the org's chain, with the actor, the session-less client and no reason.
    expect(await auditOf(res, a.orgId)).toEqual([
      expect.objectContaining({ action: 'submission.exported', outcome: 'success', actorId: a.editor, resourceType: 'export', resourceId: id, formId: a.formId, metadata: { format: 'xlsx', includeSensitive: false } }),
    ]);
    // One job, naming the export as its resource, with ids only; the worker accepts its signature.
    const jobs = await jobsFor(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: 'created', data: { orgId: a.orgId, resource: { type: 'export', id }, data: { exportId: id } } });
    expect(Object.keys(jobs[0]!.data.data)).toEqual(['exportId']);
    expect(verifyJob(keyring, 'export.build', jobs[0]!.data).ok).toBe(true);
  });

  it('lets an owner ask too', async () => {
    const res = await ask(a, a.owner, { format: 'csv', scope: { kind: 'selected', ids: [randomUUID()] } });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('answers 404 for a form of another org, and writes and enqueues nothing', async () => {
    const before = await exportsOf(b.orgId);
    const res = await ask(b, b.editor, {}, randomUUID(), a.formId);
    expect(res.statusCode, res.body).toBe(404);
    expect(await exportsOf(a.orgId)).toBeGreaterThan(0);
    expect(await exportsOf(b.orgId)).toBe(before);
    expect(res.body).not.toContain('Intake exports-a');
    // A form that does not exist is the same answer.
    expect((await ask(a, a.editor, {}, randomUUID(), randomUUID())).statusCode).toBe(404);
  });
});

describe('the request', () => {
  it('keeps what the caller asked for, normalised: ids lower-cased, unique and sorted; instants in UTC', async () => {
    const [x, y] = [randomUUID(), randomUUID()].sort();
    const res = await ask(a, a.editor, { scope: { kind: 'selected', ids: [y!.toUpperCase(), x!, y!] } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ scope: { kind: 'selected', count: 2 } });
    expect((await rowOf(res.json<{ id: string }>().id))!.scope).toEqual({ kind: 'selected', ids: [x, y] });

    const ranged = await ask(a, a.editor, { scope: { kind: 'filtered', from: '2026-11-01T05:30:00+05:30', to: '2026-11-15T00:00:00Z' } });
    expect(ranged.statusCode, ranged.body).toBe(200);
    expect(ranged.json()).toMatchObject({ scope: { kind: 'filtered', from: '2026-11-01T00:00:00.000Z', to: '2026-11-15T00:00:00.000Z' } });
    expect((await rowOf(ranged.json<{ id: string }>().id))!.scope).toEqual({ kind: 'filtered', from: '2026-11-01T00:00:00.000Z', to: '2026-11-15T00:00:00.000Z' });
  });

  it('refuses a body that is not valid, with 400 and nothing written', async () => {
    const before = await exportsOf(a.orgId);
    const tooMany = Array.from({ length: MAX_SELECTED + 1 }, () => randomUUID());
    const bad: Array<[string, Sent | Record<string, unknown>]> = [
      ['an unknown format', { format: 'pdf' }],
      ['no ids', { scope: { kind: 'selected', ids: [] } }],
      ['too many ids', { scope: { kind: 'selected', ids: tooMany } }],
      ['an id that is not a uuid', { scope: { kind: 'selected', ids: ['not-a-uuid'] } }],
      ['a range that runs backwards', { scope: { kind: 'filtered', from: '2026-11-15T00:00:00Z', to: '2026-11-01T00:00:00Z' } }],
      ['an instant that is not an instant', { scope: { kind: 'filtered', from: 'yesterday' } }],
      ['an unknown scope', { scope: { kind: 'everything' } }],
      ['a key the route does not know', { org: b.orgId } as Record<string, unknown>],
      ['a scope with a key it does not know', { scope: { kind: 'all', formId: b.formId } }],
      ['a reason over the limit', { reason: 'x'.repeat(1001) }],
    ];
    for (const [what, body] of bad) {
      const res = await ask(a, a.editor, body as Sent);
      expect(res.statusCode, `${what}: ${res.body}`).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    // The largest allowed selection is accepted.
    const largest = await ask(a, a.editor, { scope: { kind: 'selected', ids: tooMany.slice(0, MAX_SELECTED) } });
    expect(largest.statusCode, largest.body).toBe(200);
    expect(await exportsOf(a.orgId)).toBe(before + 1);
  });
});

describe('sensitive fields', () => {
  it('need a reason: none, or a blank one, is 422 EXPORT_REASON_REQUIRED, and nothing is written or enqueued', async () => {
    const before = await exportsOf(a.orgId);
    const jobsBefore = Number((await owner.query(`select count(*) as n from pgboss.job where name = 'export.build'`)).rows[0].n);
    for (const reason of [undefined, '', '   \n\t ']) {
      const res = await ask(a, a.editor, { includeSensitive: true, ...(reason === undefined ? {} : { reason }) });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json()).toMatchObject({ code: 'EXPORT_REASON_REQUIRED' });
      expect(await auditOf(res, a.orgId)).toEqual([]);
    }
    expect(await exportsOf(a.orgId)).toBe(before);
    expect(Number((await owner.query(`select count(*) as n from pgboss.job where name = 'export.build'`)).rows[0].n)).toBe(jobsBefore);
  });

  it('with a reason: the row and the audit record both carry it (trimmed), and the audit record says sensitive fields are included', async () => {
    const res = await ask(a, a.editor, { includeSensitive: true, reason: '  DSR #12: the principal asked for a copy  ' });
    expect(res.statusCode, res.body).toBe(200);
    const id = res.json<{ id: string }>().id;
    expect(res.json()).toMatchObject({ includeSensitive: true });
    expect(await rowOf(id)).toMatchObject({ include_sensitive: true, reason: 'DSR #12: the principal asked for a copy' });
    expect(await auditOf(res, a.orgId)).toEqual([
      expect.objectContaining({ action: 'submission.exported', outcome: 'success', reason: 'DSR #12: the principal asked for a copy', metadata: { format: 'csv', includeSensitive: true } }),
    ]);
  });
});

describe('the Idempotency-Key', () => {
  it('is required: without one, 400, nothing written; a key that is not printable ASCII is refused too', async () => {
    const before = await exportsOf(a.orgId);
    const none = await ask(a, a.editor, {}, null);
    expect(none.statusCode, none.body).toBe(400);
    expect(none.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await ask(a, a.editor, {}, 'has a space')).statusCode).toBe(400);
    expect((await ask(a, a.editor, {}, 'x'.repeat(256))).statusCode).toBe(400);
    expect(await exportsOf(a.orgId)).toBe(before);
  });

  it('a repeat returns the same export and enqueues nothing: one row, one audit record, one job', async () => {
    const key = randomUUID();
    const first = await ask(a, a.editor, { format: 'xlsx' }, key);
    const again = await ask(a, a.editor, { format: 'xlsx' }, key);
    expect(first.statusCode, first.body).toBe(200);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    const id = first.json<{ id: string }>().id;
    expect(again.json()).toEqual(first.json());
    expect(await jobsFor(id)).toHaveLength(1);
    expect(await auditOf(again, a.orgId)).toEqual([]);
    expect(Number((await owner.query('select count(*) as n from exports where idempotency_key = $1', [key])).rows[0].n)).toBe(1);
    // The same ids in another order and case are the same request.
    const [x, y] = [randomUUID(), randomUUID()];
    const sel = randomUUID();
    const one = await ask(a, a.editor, { scope: { kind: 'selected', ids: [x, y] } }, sel);
    const two = await ask(a, a.editor, { scope: { kind: 'selected', ids: [y.toUpperCase(), x] } }, sel);
    expect(two.json<{ id: string }>().id).toBe(one.json<{ id: string }>().id);
  });

  it('cannot be reused for another export: another format, scope, option, form or requester is 422 EXPORT_KEY_REUSED and changes nothing', async () => {
    const key = randomUUID();
    const first = await ask(a, a.editor, { format: 'csv' }, key);
    expect(first.statusCode).toBe(200);
    const id = first.json<{ id: string }>().id;
    const other = await newFormIn(a);
    const attempts: Array<[string, () => ReturnType<typeof ask>]> = [
      ['another format', () => ask(a, a.editor, { format: 'xlsx' }, key)],
      ['another scope', () => ask(a, a.editor, { scope: { kind: 'filtered', from: '2026-01-01T00:00:00Z' } }, key)],
      ['sensitive fields', () => ask(a, a.editor, { includeSensitive: true, reason: 'because' }, key)],
      ['another form', () => ask(a, a.editor, {}, key, other)],
      ['another member', () => ask(a, a.editor2, {}, key)],
    ];
    for (const [what, run] of attempts) {
      const res = await run();
      expect(res.statusCode, `${what}: ${res.body}`).toBe(422);
      expect(res.json()).toMatchObject({ code: 'EXPORT_KEY_REUSED' });
      // The answer is the refusal, never the other export.
      expect(res.body).not.toContain(id);
    }
    expect(await jobsFor(id)).toHaveLength(1);
    expect(Number((await owner.query('select count(*) as n from exports where idempotency_key = $1', [key])).rows[0].n)).toBe(1);
  });

  it('is per org: org B may use a key that org A used', async () => {
    const key = randomUUID();
    expect((await ask(a, a.editor, {}, key)).statusCode).toBe(200);
    expect((await ask(b, b.editor, {}, key)).statusCode).toBe(200);
  });

  it('holds when the same request is sent many times at once: one export, one job', async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => ask(a, a.editor, { format: 'xlsx' }, key)));
    expect(results.map((r) => r.statusCode)).toEqual(Array(6).fill(200));
    expect(new Set(results.map((r) => r.json<{ id: string }>().id)).size).toBe(1);
    expect(await jobsFor(results[0]!.json<{ id: string }>().id)).toHaveLength(1);
  });
});

async function newFormIn(org: Org): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/forms', headers: as(org.owner, org.orgId), payload: { title: 'Another form' } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ id: string }>().id;
}

describe('the quotas', () => {
  it(`allow ${MAX_ACTIVE} exports queued or running at once: the next is 429 EXPORT_QUOTA_REACHED with Retry-After, and a finished one frees a place`, async () => {
    const q = await newOrg('exports-quota-active');
    const ids: string[] = [];
    for (let n = 0; n < MAX_ACTIVE; n += 1) {
      const res = await ask(q, q.editor);
      expect(res.statusCode, `${n}: ${res.body}`).toBe(200);
      ids.push(res.json<{ id: string }>().id);
    }
    const refused = await ask(q, q.editor, {}, 'eleventh-1');
    expect(refused.statusCode, refused.body).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'EXPORT_QUOTA_REACHED' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(await exportsOf(q.orgId)).toBe(MAX_ACTIVE);
    // Another org is not held back by this one's.
    expect((await ask(b, b.editor)).statusCode).toBe(200);
    // A repeat of an accepted request is not a new export: still 200 while the org is at its limit.
    const replay = await ask(q, q.editor, {}, (await owner.query<{ k: string }>('select idempotency_key as k from exports where id = $1', [ids[0]])).rows[0]!.k);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json<{ id: string }>().id).toBe(ids[0]);
    // A running one counts as well; a finished one does not.
    await owner.query(`update exports set status = 'running' where id = $1`, [ids[1]]);
    expect((await ask(q, q.editor)).statusCode).toBe(429);
    await finish(ids[0]!, 'x');
    await owner.query(`update exports set status = 'failed', error = 'boom' where id = $1`, [ids[1]]);
    expect((await ask(q, q.editor, {}, 'eleventh-2')).statusCode).toBe(200);
    expect((await ask(q, q.editor, {}, 'eleventh-3')).statusCode).toBe(200);
    expect((await ask(q, q.editor, {}, 'eleventh-4')).statusCode).toBe(429);
  });

  it(`let at most ${MAX_ACTIVE} of ${MAX_ACTIVE + 5} requests sent at the same time in`, async () => {
    const q = await newOrg('exports-quota-race');
    const results = await Promise.all(Array.from({ length: MAX_ACTIVE + 5 }, () => ask(q, q.editor)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(MAX_ACTIVE);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);
    expect(await exportsOf(q.orgId)).toBe(MAX_ACTIVE);
  });

  it(`allow ${MAX_PER_DAY} exports in 24 hours: the next is 429 with Retry-After until the oldest is a day old`, async () => {
    const q = await newOrg('exports-quota-day');
    // Finished exports asked for 2 hours ago (the oldest) and a minute ago: all of them count toward the day.
    await owner.query(
      `insert into exports (id, org_id, form_id, requested_by, format, scope, idempotency_key, status, created_at)
       select gen_random_uuid(), $1, $2, $3, 'csv', '{"kind":"all"}'::jsonb, 'day-' || n, 'ready', now() - ($4 || ' minutes')::interval from generate_series(1, $5) as n`,
      [q.orgId, q.formId, q.editor, '1', MAX_PER_DAY],
    );
    await owner.query(`update exports set created_at = now() - interval '2 hours' where org_id = $1 and idempotency_key = 'day-1'`, [q.orgId]);
    const refused = await ask(q, q.editor);
    expect(refused.statusCode, refused.body).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'EXPORT_QUOTA_REACHED' });
    const wait = Number(refused.headers['retry-after']);
    // 22 hours, give or take the time the test took.
    expect(wait).toBeGreaterThan(21 * 3600);
    expect(wait).toBeLessThanOrEqual(22 * 3600);
    // The oldest ages out: a place is free again.
    await owner.query(`update exports set created_at = now() - interval '25 hours' where org_id = $1 and idempotency_key = 'day-1'`, [q.orgId]);
    expect((await ask(q, q.editor)).statusCode).toBe(200);
  });

  it('do not let a queued export that has been stuck for hours hold a place for ever', async () => {
    const q = await newOrg('exports-quota-stuck');
    for (let n = 0; n < MAX_ACTIVE; n += 1) expect((await ask(q, q.editor)).statusCode).toBe(200);
    expect((await ask(q, q.editor)).statusCode).toBe(429);
    await owner.query(`update exports set created_at = now() - interval '7 hours' where org_id = $1 and id = (select id from exports where org_id = $1 limit 1)`, [q.orgId]);
    expect((await ask(q, q.editor)).statusCode).toBe(200);
  });
});

describe('the state of an export', () => {
  it('is readable by the member who asked for it: queued, then ready with its size and time, then expired once its time has passed', async () => {
    const res = await ask(a, a.editor, { format: 'xlsx' });
    const id = res.json<{ id: string }>().id;
    const queued = await status(a, a.editor, id);
    expect(queued.statusCode, queued.body).toBe(200);
    expect(queued.json()).toMatchObject({ id, status: 'queued', format: 'xlsx', rowCount: null, bytes: null, expiresAt: null });

    await owner.query(`update exports set status = 'running' where id = $1`, [id]);
    expect((await status(a, a.editor, id)).json()).toMatchObject({ status: 'running' });

    await finish(id, 'a,b\n1,2\n');
    const ready = (await status(a, a.editor, id)).json<Record<string, unknown>>();
    expect(ready).toMatchObject({ id, status: 'ready', rowCount: 3, bytes: 8 });
    expect(typeof ready.expiresAt).toBe('string');
    expect(new Date(ready.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(ready).not.toHaveProperty('objectKey');

    // The sweep has not run, but the file is past its time: it is expired for the caller.
    await owner.query(`update exports set expires_at = now() - interval '1 minute' where id = $1`, [id]);
    expect((await status(a, a.editor, id)).json()).toMatchObject({ id, status: 'expired' });
  });

  it('says why a failed export failed, and nothing of the error otherwise', async () => {
    const id = (await ask(a, a.editor)).json<{ id: string }>().id;
    await owner.query(`update exports set status = 'failed', error = 'the file could not be written', finished_at = now() where id = $1`, [id]);
    expect((await status(a, a.editor, id)).json()).toMatchObject({ status: 'failed', error: 'the file could not be written' });
  });

  it('is the requester’s alone: another member of the org, an owner included, and org B all get 404', async () => {
    const id = (await ask(a, a.editor)).json<{ id: string }>().id;
    for (const [org, who] of [[a, a.editor2], [a, a.owner], [b, b.owner], [b, b.editor]] as Array<[Org, string]>) {
      const res = await status(org, who, id);
      expect(res.statusCode, `${who}: ${res.body}`).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect((await status(a, a.editor, randomUUID())).statusCode).toBe(404);
    expect((await status(a, a.editor, 'not-a-uuid')).statusCode).toBe(400);
  });
});

describe('the download', () => {
  it('is 409 EXPORT_NOT_READY while it is queued or running, and 409 EXPORT_FAILED when it failed, without touching the store', async () => {
    const id = (await ask(a, a.editor)).json<{ id: string }>().id;
    const reads = storage.reads.length;
    const queued = await download(a, a.editor, id);
    expect(queued.statusCode, queued.body).toBe(409);
    expect(queued.json()).toMatchObject({ code: 'EXPORT_NOT_READY' });
    await owner.query(`update exports set status = 'running' where id = $1`, [id]);
    expect((await download(a, a.editor, id)).json()).toMatchObject({ code: 'EXPORT_NOT_READY' });
    await owner.query(`update exports set status = 'failed', error = 'boom' where id = $1`, [id]);
    const failed = await download(a, a.editor, id);
    expect(failed.statusCode).toBe(409);
    expect(failed.json()).toMatchObject({ code: 'EXPORT_FAILED' });
    expect(storage.reads).toHaveLength(reads);
  });

  it('streams a ready export through the API with its bytes exactly, safe headers and an export.downloaded record', async () => {
    const id = (await ask(a, a.editor, { format: 'xlsx' })).json<{ id: string }>().id;
    // Not text: every byte value, so a stream that re-encodes it as UTF-8 would be caught.
    const bytes = Uint8Array.from({ length: 4096 }, (_, i) => i % 256);
    await finish(id, bytes);
    const res = await download(a, a.editor, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(Buffer.compare(res.rawPayload, Buffer.from(bytes))).toBe(0);
    expect(res.headers).toMatchObject({
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-length': '4096',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    });
    const disposition = String(res.headers['content-disposition']);
    // ASCII only whatever the form's title holds (it holds Devanagari): the header can be sent and read anywhere.
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.xlsx"; filename\*=UTF-8''[A-Za-z0-9._%-]+\.xlsx$/);
    expect(disposition).toMatch(/^[\x20-\x7e]+$/);
    expect(disposition).toContain('Intake-exports-a-');
    expect(await auditOf(res, a.orgId)).toEqual([
      expect.objectContaining({ action: 'export.downloaded', outcome: 'success', actorId: a.editor, resourceType: 'export', resourceId: id, formId: a.formId, metadata: { format: 'xlsx', bytes: 4096 } }),
    ]);
    // A CSV is served as text.
    const csv = (await ask(a, a.editor)).json<{ id: string }>().id;
    await finish(csv, 'name\nनमस्ते\n');
    const text = await download(a, a.editor, csv);
    expect(text.statusCode).toBe(200);
    expect(text.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(text.rawPayload.toString('utf8')).toBe('name\nनमस्ते\n');
  });

  it('is 410 EXPORT_EXPIRED once its time has passed, or when the object is gone, and the record is not written for it', async () => {
    const id = (await ask(a, a.editor)).json<{ id: string }>().id;
    await finish(id, 'x\n', { expiresIn: '-1 minute' });
    const late = await download(a, a.editor, id);
    expect(late.statusCode, late.body).toBe(410);
    expect(late.json()).toMatchObject({ code: 'EXPORT_EXPIRED' });
    expect(await auditOf(late, a.orgId)).toEqual([]);

    // Marked expired by the sweep.
    await owner.query(`update exports set status = 'expired' where id = $1`, [id]);
    expect((await download(a, a.editor, id)).statusCode).toBe(410);

    // Ready and in time, but the object was removed from the store.
    const gone = (await ask(a, a.editor)).json<{ id: string }>().id;
    await finish(gone, 'x\n', { put: false });
    const missing = await download(a, a.editor, gone);
    expect(missing.statusCode, missing.body).toBe(410);
    expect(await auditOf(missing, a.orgId)).toEqual([]);
  });

  it('is the requester’s alone: another editor, an owner and org B get 404 and no bytes, and leave no download record', async () => {
    const id = (await ask(a, a.editor)).json<{ id: string }>().id;
    await finish(id, 'secret,rows\n');
    const reads = storage.reads.length;
    for (const [org, who] of [[a, a.editor2], [a, a.owner], [b, b.owner]] as Array<[Org, string]>) {
      const res = await download(org, who, id);
      expect(res.statusCode, `${who}: ${res.body}`).toBe(404);
      expect(res.body).not.toContain('secret');
      expect(await auditOf(res, org.orgId)).toEqual([]);
    }
    expect(storage.reads).toHaveLength(reads);
    expect((await download(a, a.editor, id)).statusCode).toBe(200);
  });

  it('never streams an object outside its org: a row whose key names another org’s prefix is refused', async () => {
    const id = (await ask(a, a.editor)).json<{ id: string }>().id;
    storage.seed('exports', `${b.orgId}/stolen.csv`, 'org b rows\n');
    await owner.query(`update exports set status = 'ready', object_key = $2, bytes = 11, row_count = 1, expires_at = now() + interval '1 hour' where id = $1`, [id, `${b.orgId}/stolen.csv`]);
    const res = await download(a, a.editor, id);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('org b rows');
  });
});

describe('without an object store or a queue', () => {
  it('every route answers 503 when no object store is set up, and the request writes nothing', async () => {
    const before = await exportsOf(a.orgId);
    const asked = await ask(a, a.editor, {}, randomUUID(), a.formId, bare);
    expect(asked.statusCode, asked.body).toBe(503);
    expect(asked.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    const id = (await ask(a, a.editor)).json<{ id: string }>().id;
    expect((await status(a, a.editor, id, bare)).statusCode).toBe(503);
    expect((await download(a, a.editor, id, bare)).statusCode).toBe(503);
    expect(await exportsOf(a.orgId)).toBe(before + 1);
  });

  it('a request is 503 when there is no queue to send the job to, and then writes no export and no audit record', async () => {
    const before = await exportsOf(a.orgId);
    const res = await ask(a, a.editor, {}, randomUUID(), a.formId, noQueue);
    expect(res.statusCode, res.body).toBe(503);
    expect((await auditOf(res, a.orgId)).map((e) => e.action)).not.toContain('submission.exported');
    expect(await exportsOf(a.orgId)).toBe(before);
    // The form is looked up first, so a form of another org is still 404 and not a hint about the server's set-up.
    expect((await ask(b, b.editor, {}, randomUUID(), a.formId, noQueue)).statusCode).toBe(404);
  });
});
