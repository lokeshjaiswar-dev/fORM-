import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { editionSummary, runtimeEdition, type RuntimeEdition } from '@form/config';
import { createDb, provision, withTenant, type DbHandle } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { createFileStore } from '../src/files.ts';
import { createVersionLoader, type VersionLoader } from '../src/submit/live.ts';
import { countSubmission, submit as submitPipeline } from '../src/submit/pipeline.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

/*
 * WP-1.12: the two rules of the submit transaction that depend on time and on concurrency. The limit is counted by one
 * guarded UPDATE at the end of the transaction, so N submits at once against a limit of N store exactly N; and a
 * version that a newer one replaced keeps taking answers for `accept_previous_versions_hours`, measured at the moment
 * the answers arrive (the app's `now` is frozen here, so the test sets that moment).
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const HOUR = 3_600_000;
/** More than any test sends from one address, so the throttle never speaks. */
const BUDGET = { max: 100_000, windowSeconds: 600 };

let app: FastifyInstance;
let owner: pg.Pool;
let appDb: DbHandle;
let edition: RuntimeEdition;
let secret: () => Uint8Array;
let dir: string;
let orgId: string;
let userId: string;
/** The moment the app believes it is. */
let clock = new Date();

const as = () => ({ 'x-fr-dev-user': userId, 'x-fr-org': orgId, ...BROWSER });
const name = (value: string) => ({ type: 'short_text', value });

async function publish(title: string): Promise<{ id: string; slug: string; versionId: string }> {
  const { id } = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(), payload: { title } })).json<{ id: string }>();
  const draft = draftWith(id, [fieldBlock('name', 'short_text', {}, { required: true })], title);
  const put = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...as(), 'if-match': '0' }, payload: { draft } });
  expect(put.statusCode, put.body).toBe(200);
  return { id, ...(await publishAgain(id)) };
}

const publishAgain = async (id: string): Promise<{ slug: string; versionId: string }> => {
  const live = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(), payload: {} });
  expect(live.statusCode, live.body).toBe(200);
  return live.json<{ slug: string; versionId: string }>();
};

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

const submit = (slug: string, versionId: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/p/${slug}/submissions`,
    headers: { 'idempotency-key': randomUUID() },
    payload: { formVersionId: versionId, answers: { name: name('Asha') }, fields: [], locale: 'en-IN' },
  });

const count = async (sql: string, formId: string): Promise<number> => Number((await owner.query(sql, [formId])).rows[0].n);
const stored = (formId: string) => count('select count(*) as n from submissions where form_id = $1', formId);

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_submit_limits');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  appDb = createDb(urls.fr_app, { max: 40, applicationName: 'fr-api-submit-limits-test' });
  dir = await mkdtemp(path.join(tmpdir(), 'fr-submit-limits-'));
  orgId = randomUUID();
  userId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'submit-limits']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@submit-limits.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);
  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, DATABASE_POOL_MAX: '40', AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  edition = runtimeEdition(editionSummary(parsed.config.edition));
  secret = () => parsed.config.auth.secret;
  app = await buildApp(parsed.config, {
    underPressure: false,
    files: createFileStore(dir),
    now: () => clock,
    authLimits: { auth_submit_ip: BUDGET, auth_submit_form: BUDGET, auth_files_ip: BUDGET, auth_files_form: BUDGET },
  });
});

afterAll(async () => {
  await app?.close();
  await appDb?.close();
  await owner?.end();
  await rm(dir, { recursive: true, force: true });
});

describe('the submission limit under load (ACC-04)', () => {
  it('stores exactly N responses when 50 submits race for a limit of N = 5, and refuses the other 45 with LIMIT_REACHED', async () => {
    clock = new Date();
    const f = await publish('Limit race');
    await setAccess(f.id, { submissionLimit: 5 });
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(f.slug, f.versionId)));
    const ok = results.filter((r) => r.statusCode === 200);
    const refused = results.filter((r) => r.statusCode !== 200);
    expect(ok).toHaveLength(5);
    expect(refused).toHaveLength(45);
    expect(refused.map((r) => `${r.statusCode} ${r.json<{ code: string }>().code}`)).toEqual(Array(45).fill('409 LIMIT_REACHED'));
    expect(new Set(ok.map((r) => r.json<{ submissionId: string }>().submissionId)).size).toBe(5);
    // Rows, the limit's counter, the form's own count and the kept keys all say five: a refused request left nothing behind.
    expect(await stored(f.id)).toBe(5);
    expect(await count('select submitted_total as n from form_counters where form_id = $1', f.id)).toBe(5);
    expect(await count('select submission_count as n from forms where id = $1', f.id)).toBe(5);
    expect(await count('select count(*) as n from submission_idempotency where form_id = $1', f.id)).toBe(5);
  });

  it('counts with one guarded update: 40 transactions racing past the status check admit exactly the limit', async () => {
    // The status check stops most late requests before they open a transaction. This races the last statement alone, the
    // one that has to hold when many requests got past the check at once.
    clock = new Date();
    const f = await publish('Limit guard');
    await setAccess(f.id, { submissionLimit: 5 });
    const counted = await Promise.all(
      Array.from({ length: 40 }, () => withTenant(appDb.db, { orgId, actor: 'respondent', requestId: 'limit-guard' }, (tx) => countSubmission(tx, f.id))),
    );
    expect(counted.filter(Boolean)).toHaveLength(5);
    expect(await count('select submitted_total as n from form_counters where form_id = $1', f.id)).toBe(5);
    // No limit, no refusal; and a form whose limit is raised takes more.
    const free = await publish('Limit guard free');
    expect(await Promise.all(Array.from({ length: 12 }, () => withTenant(appDb.db, { orgId, actor: 'respondent', requestId: 'limit-guard' }, (tx) => countSubmission(tx, free.id))))).toEqual(Array(12).fill(true));
    await setAccess(f.id, { submissionLimit: 7 });
    const more = await Promise.all(Array.from({ length: 5 }, () => withTenant(appDb.db, { orgId, actor: 'respondent', requestId: 'limit-guard' }, (tx) => countSubmission(tx, f.id))));
    expect(more.filter(Boolean)).toHaveLength(2);
  });

  it('rolls the whole response back, key included, when the counter says the limit is reached after the status check passed', async () => {
    clock = new Date();
    const f = await publish('Limit rollback');
    await setAccess(f.id, { submissionLimit: 1 });
    // A request that read the form while it had room, and whose transaction starts after another response took the last
    // place: the version loader runs between the status check and the transaction, so the test lands that response there.
    const loader = createVersionLoader({ db: appDb.db, edition });
    const lateByOne: VersionLoader = {
      get: async (ref, versionId, requestId) => {
        await owner.query('update form_counters set submitted_total = 1 where form_id = $1', [f.id]);
        return loader.get(ref, versionId, requestId);
      },
    };
    const key = randomUUID();
    const request = {
      slug: f.slug,
      requestId: 'limit-rollback',
      idempotencyKey: key,
      accessToken: undefined,
      userAgent: undefined,
      body: { formVersionId: f.versionId, answers: { name: name('Asha') }, locale: 'en-IN', client: undefined },
    };
    await expect(submitPipeline({ db: appDb.db, secret: secret(), loader: lateByOne, now: () => clock }, request)).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
    expect(await stored(f.id)).toBe(0);
    expect(await count('select count(*) as n from submission_idempotency where form_id = $1', f.id)).toBe(0);
    expect(await count('select submission_count as n from forms where id = $1', f.id)).toBe(0);
    expect(await count('select submitted_total as n from form_counters where form_id = $1', f.id)).toBe(1);
  });
});

describe('accepting the version a newer one replaced (F-34, frozen deps.now)', () => {
  it('takes answers for the previous version 71 hours after the republish and refuses them 73 hours after (default 72)', async () => {
    clock = new Date();
    const republishedAt = clock;
    const f = await publish('Window');
    const next = await publishAgain(f.id);
    expect(next.versionId).not.toBe(f.versionId);

    clock = new Date(republishedAt.getTime() + 71 * HOUR);
    const inside = await submit(f.slug, f.versionId);
    expect(inside.statusCode, inside.body).toBe(200);
    expect((await owner.query<{ form_version_id: string }>('select form_version_id from submissions where id = $1', [inside.json<{ submissionId: string }>().submissionId])).rows[0]!.form_version_id).toBe(f.versionId);

    clock = new Date(republishedAt.getTime() + 73 * HOUR);
    const outside = await submit(f.slug, f.versionId);
    expect(outside.statusCode).toBe(409);
    expect(outside.json()).toMatchObject({ code: 'VERSION_SUPERSEDED' });
    // The live version is taken at any time.
    expect((await submit(f.slug, next.versionId)).statusCode).toBe(200);
    expect(await stored(f.id)).toBe(2);
  });

  it('measures the window from the moment the newer version went live, and a window of exactly its length is over', async () => {
    clock = new Date();
    const f = await publish('Window edge');
    await publishAgain(f.id);
    // The publish route stamps the moment the newer version went live with the database's clock, not the app's, so the
    // edge is read from the row.
    const state = await owner.query<{ superseded_at: Date }>('select superseded_at from form_version_state where version_id = $1', [f.versionId]);
    const republishedAt = state.rows[0]!.superseded_at;
    clock = new Date(republishedAt.getTime() + 72 * HOUR - 1);
    expect((await submit(f.slug, f.versionId)).statusCode).toBe(200);
    clock = new Date(republishedAt.getTime() + 72 * HOUR);
    expect((await submit(f.slug, f.versionId)).statusCode).toBe(409);
  });

  it('follows the form’s own setting: 24 hours, or none at all', async () => {
    clock = new Date();
    const republishedAt = clock;
    const f = await publish('Window setting');
    await publishAgain(f.id);
    await setAccess(f.id, { acceptPreviousVersionsHours: 24 });
    clock = new Date(republishedAt.getTime() + 23 * HOUR);
    expect((await submit(f.slug, f.versionId)).statusCode).toBe(200);
    clock = new Date(republishedAt.getTime() + 25 * HOUR);
    expect((await submit(f.slug, f.versionId)).statusCode).toBe(409);
    clock = new Date(republishedAt.getTime() + 30 * HOUR);
    await setAccess(f.id, { acceptPreviousVersionsHours: 720 });
    expect((await submit(f.slug, f.versionId)).statusCode).toBe(200);
    await setAccess(f.id, { acceptPreviousVersionsHours: 0 });
    expect((await submit(f.slug, f.versionId)).statusCode).toBe(409);
  });

  it('never takes a version that was retired', async () => {
    clock = new Date();
    const f = await publish('Window retired');
    await publishAgain(f.id);
    await owner.query('update form_version_state set retired_at = $2 where version_id = $1', [f.versionId, clock]);
    const refused = await submit(f.slug, f.versionId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'VERSION_SUPERSEDED' });
  });
});
