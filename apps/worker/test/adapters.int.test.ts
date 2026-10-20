import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPostgresReplayStore, createProofOfWorkCaptcha } from '@form/adapters/captcha';
import { createPgBossQueue, installQueueSchema, parseJobKeyring, type PgBossQueue } from '@form/adapters/queue';
import { createPostgresSearchIndex } from '@form/adapters/search';
import { toIsoInstant } from '@form/ports';
import { createDb, provision, txExecutor, withTenant, type DbHandle, type RoleName, type TenantCtx } from '@form/db';
import { CAPTCHA_CONTRACT_ORG_ID, createTestDatabase, runCaptchaContract, runQueueContract, runSearchIndexContract, solveAltcha } from '@form/testkit';
import { jobGuard } from '../src/guard.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

/** The adapters that live on Postgres, against the migrated schema as fr_app: the pg-boss queue, FTS search, captcha replay. */

const log = pino({ level: 'silent' });
const secret = () => randomBytes(32).toString('base64url');

let urls: Record<RoleName, string>;
let owner: pg.Pool;
let app: DbHandle;
const queues: PgBossQueue[] = [];

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_adapters');
  ({ urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false }));
  await installQueueSchema({ connectionString: urls.fr_migrator, appRole: 'fr_app', policies: { 'system.heartbeat': { retryDelaySeconds: 1, retryBackoff: false } } });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  app = createDb(urls.fr_app, { max: 8 });
});

afterAll(async () => {
  for (const q of queues) await q.stop({ graceMs: 1000 });
  await app?.close();
  await owner?.end();
});

const runnerAs =
  (ctx: Omit<TenantCtx, 'orgId' | 'requestId'>) =>
  <T>(orgId: string, fn: (sql: ReturnType<typeof txExecutor>) => Promise<T>) =>
    withTenant(app.db, { ...ctx, orgId, requestId: 'adapters-int' }, (tx) => fn(txExecutor(tx)));
const inTenant = runnerAs({ actor: 'system' });

async function seedOrg(): Promise<string> {
  const id = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [id, `o-${id.slice(0, 8)}`]);
  return id;
}

runQueueContract('pg-boss (WP-0.14 adapter) as fr_app', async () => {
  const org = await seedOrg();
  const worker = createPgBossQueue({
    connectionString: urls.fr_app,
    keyring: parseJobKeyring(`k1:${secret()}`),
    mode: 'worker',
    pollingIntervalSeconds: 0.5,
    ...jobGuard(app.db, log),
  });
  const forger = createPgBossQueue({ connectionString: urls.fr_app, keyring: parseJobKeyring(`k1:${secret()}`), mode: 'producer' });
  queues.push(worker, forger);
  await worker.start();
  await forger.start();
  return {
    impl: worker,
    forger,
    orgRequest: () => ({ orgId: org, resource: { type: 'org', id: org }, data: {} }),
    deadLettered: async (jobId) => {
      const { rows } = await owner.query<{ n: number }>(`select count(*)::int as n from pgboss.job where name = 'system.heartbeat.dead' and source_id = $1`, [jobId]);
      return (rows[0]?.n ?? 0) > 0;
    },
  };
});

runSearchIndexContract('Postgres FTS (submission_search) as fr_app', () => ({ impl: createPostgresSearchIndex({ inTenant }) }));

describe('search index in the respondent submit transaction', () => {
  it('indexes a new submission, and cannot overwrite or read an existing document (submission_search_data_access)', async () => {
    const org = await seedOrg();
    const key = { submissionId: randomUUID(), receivedAt: toIsoInstant(new Date()) };
    const doc = (text: string) => ({ ...key, formId: randomUUID(), locale: 'en-IN', text: [text] });
    const respondent = createPostgresSearchIndex({ inTenant: runnerAs({ actor: 'respondent', subjectIds: [randomUUID()] }) });
    await respondent.upsert(org, [doc('original answers')]);
    await respondent.upsert(org, [doc('overwritten answers')]);
    const system = createPostgresSearchIndex({ inTenant });
    const { rows } = await owner.query<{ form: string }>('select form_id::text as form from submission_search where org_id = $1', [org]);
    expect(rows).toHaveLength(1);
    const hit = await system.query(org, { formId: rows[0]!.form, text: 'original', limit: 10 });
    expect(hit.hits.map((h) => h.submissionId)).toEqual([key.submissionId]);
    expect(await respondent.query(org, { formId: rows[0]!.form, text: 'original', limit: 10 })).toEqual({ hits: [] });
    const reader = createPostgresSearchIndex({ inTenant: runnerAs({ actor: 'user', userId: randomUUID(), perms: ['forms.read'] }) });
    expect(await reader.query(org, { formId: rows[0]!.form, text: 'original', limit: 10 })).toEqual({ hits: [] });
  });
});

runCaptchaContract('proof of work, Postgres replay store as fr_app', async () => {
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2) on conflict (id) do nothing', [CAPTCHA_CONTRACT_ORG_ID, 'captcha-contract']);
  let t = Date.now();
  const now = () => t;
  const hmacKey = randomBytes(32);
  const impl = createProofOfWorkCaptcha({ hmacKey, challengeUrl: 'https://api.form.test/c', replay: createPostgresReplayStore({ inTenant }), maxNumber: 500, now });
  return {
    impl,
    solve: async (c) => solveAltcha(impl.challenge(c)),
    expire: () => {
      t += 3_600_000;
    },
    bindsForm: true,
    checksAction: false,
    secrets: [hmacKey.toString('hex'), hmacKey.toString('base64')],
  };
});

describe('captcha replay store on Postgres', () => {
  it('lets a proof-of-work solution pass once across replicas, and only in its org', async () => {
    const org = await seedOrg();
    const hmacKey = randomBytes(32);
    const replica = () => createProofOfWorkCaptcha({ hmacKey, challengeUrl: 'https://api.form.test/c', replay: createPostgresReplayStore({ inTenant }), maxNumber: 500 });
    const ctx = { orgId: org, formId: randomUUID() };
    const token = solveAltcha(replica().challenge(ctx));
    expect(await replica().verify(token, ctx)).toEqual({ ok: true });
    expect(await replica().verify(token, ctx)).toEqual({ ok: false });
    expect(await replica().verify(token, { ...ctx, orgId: await seedOrg() })).toEqual({ ok: false });
    const { rows } = await owner.query<{ n: number }>('select count(*)::int as n from captcha_redemptions where org_id = $1', [org]);
    expect(rows[0]?.n).toBe(1);
  });

  it('purges expired redemptions of an org', async () => {
    const org = await seedOrg();
    await owner.query(`insert into captcha_redemptions (org_id, challenge_hash, expires_at) values ($1, $2, now() - interval '1 minute'), ($1, $3, now() + interval '1 hour')`, [
      org,
      randomBytes(32),
      randomBytes(32),
    ]);
    expect(await createPostgresReplayStore({ inTenant }).purgeExpired(org)).toBe(1);
  });
});
