import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createPgBossQueue, installQueueSchema, parseJobKeyring, verifyJob, type JobKeyring, type PgBossQueue } from '@form/adapters/queue';
import { createDb, forms, partitionsOf, provision, rlsViolations, txExecutor, withTenant, type DbHandle, type RoleName } from '@form/db';
import { JOBS, toIsoInstant, type JobName, type JobRequest } from '@form/ports';
import { createTestDatabase } from '@form/testkit';
import { jobGuard } from '../src/guard.ts';
import { defineJob, type AnyJobDefinition } from '../src/jobs/index.ts';
import { startWorker } from '../src/runtime.ts';
import { onShutdownSignal } from '../src/signals.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

interface Org {
  id: string;
  user: string;
  form: string;
}

const log = pino({ level: 'silent' });
const secret = () => randomBytes(32).toString('base64url');

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let urls: Record<RoleName, string>;
let owner: pg.Pool;
let app: DbHandle;
let keyring: JobKeyring;
let producer: PgBossQueue;
let a: Org;
let b: Org;
const queues: PgBossQueue[] = [];
const queueErrors: Error[] = [];

async function seedOrg(slug: string): Promise<Org> {
  const org: Org = { id: randomUUID(), user: randomUUID(), form: randomUUID() };
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [org.id, slug]);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [org.user, `owner@${slug}.test`]);
  await owner.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [org.id, org.user]);
  await owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [org.form, org.id, randomUUID(), org.user, `${slug} form`]);
  return org;
}

function workerQueue(o: { keyring?: JobKeyring } = {}): PgBossQueue {
  const q = createPgBossQueue({
    connectionString: urls.fr_app,
    keyring: o.keyring ?? keyring,
    mode: 'worker',
    applicationName: 'fr-worker-test',
    pollingIntervalSeconds: 0.5,
    ...jobGuard(app.db, log),
    onError: (err) => queueErrors.push(err),
  });
  queues.push(q);
  return q;
}

async function startRuntime(o: { jobs?: readonly AnyJobDefinition[] } = {}): Promise<PgBossQueue> {
  const queue = workerQueue();
  await queue.start();
  await startWorker({ db: app.db, log, queue, jobs: o.jobs, seedTemplates: true });
  return queue;
}

function producerWith(k: JobKeyring): PgBossQueue {
  const q = createPgBossQueue({ connectionString: urls.fr_app, keyring: k, mode: 'producer', onError: (err) => queueErrors.push(err) });
  queues.push(q);
  return q;
}

interface JobRow {
  name: string;
  state: string;
  retry_count: number;
  output: unknown;
}

async function jobRow(id: string): Promise<JobRow | undefined> {
  const { rows } = await owner.query<JobRow>('select name, state, retry_count, output from pgboss.job where id = $1', [id]);
  return rows[0];
}

async function settled(id: string, state = 'completed'): Promise<JobRow> {
  return vi.waitFor(
    async () => {
      const row = await jobRow(id);
      expect(row?.state).toBe(state);
      return row!;
    },
    { timeout: 20_000, interval: 200 },
  );
}

interface AuditRow {
  org_key: string;
  event: { actorKind: string; action: string; resourceType: string; resourceId: string; outcome: string; reason?: string; requestId: string; metadata?: Record<string, unknown> };
}

async function auditFor(jobId: string): Promise<AuditRow[]> {
  const { rows } = await owner.query<AuditRow>(`select org_key, event from audit_pending where event->>'requestId' = $1 order by id`, [`job:${jobId}`]);
  return rows;
}

const heartbeatFor = (org: Org): JobRequest<'system.heartbeat'> => ({ orgId: org.id, resource: { type: 'org', id: org.id }, data: {} });
const systemRequest = (name: JobName) => ({ orgId: null, resource: { type: 'system' as const, id: name }, data: {} });

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_worker');
  ({ urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false }));
  // A short retry delay keeps the shutdown test fast; everything else uses the production policies.
  await installQueueSchema({ connectionString: urls.fr_migrator, appRole: 'fr_app', policies: { 'system.heartbeat': { retryDelaySeconds: 1 } } });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  app = createDb(urls.fr_app, { max: 6, applicationName: 'fr-worker-test' });
  keyring = parseJobKeyring(`t1:${secret()}`);
  producer = producerWith(keyring);
  await producer.start();
  a = await seedOrg('acme');
  b = await seedOrg('globex');
});

afterAll(async () => {
  for (const q of queues) await q.stop({ graceMs: 1000 });
  await app?.close();
  await owner?.end();
});

describe('installQueueSchema', () => {
  it('creates every queue with its policy and a dead-letter queue, and is idempotent', async () => {
    const { rows } = await owner.query<{ name: string; policy: string; retry_limit: number; retry_delay_max: number | null; dead_letter: string | null }>(
      'select name, policy, retry_limit, retry_delay_max, dead_letter from pgboss.queue order by name',
    );
    const byName = new Map(rows.map((r) => [r.name, r]));
    for (const name of Object.keys(JOBS)) {
      expect(byName.get(name)?.dead_letter, name).toBe(`${name}.dead`);
      expect(byName.get(`${name}.dead`)?.retry_limit, name).toBe(0);
    }
    expect(rows).toHaveLength(Object.keys(JOBS).length * 2);
    expect(byName.get('email.send')).toMatchObject({ policy: 'standard', retry_limit: 8, retry_delay_max: 6 * 3600 });
    expect(byName.get('partitions.maintain')?.policy).toBe('singleton');
    expect(byName.get('templates.seed')?.policy).toBe('singleton');
    await installQueueSchema({ connectionString: urls.fr_migrator, appRole: 'fr_app', policies: { 'system.heartbeat': { retryDelaySeconds: 1 } } });
  });

  it('gives fr_app rows only: no DDL in the queue schema, and the RLS meta-tests still pass beside it', async () => {
    const err = await app.pool.query('create table pgboss.sneaky (id int)').then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(err?.code).toBe('42501');
    expect(await rlsViolations(owner)).toEqual([]);
  });
});

describe('a worker', () => {
  let worker: PgBossQueue;

  beforeAll(async () => {
    worker = await startRuntime();
  });
  afterAll(() => worker.stop({ graceMs: 1000 }));

  it('schedules its cron in UTC with signed envelopes and seeds templates once at boot', async () => {
    const { rows } = await owner.query<{ name: string; cron: string; timezone: string; data: unknown }>(
      'select name, cron, timezone, data from pgboss.schedule order by name',
    );
    expect(rows.map((r) => [r.name, r.cron, r.timezone])).toEqual([
      ['partitions.maintain', '15 0 * * *', 'UTC'],
      ['system.heartbeat', '*/5 * * * *', 'UTC'],
    ]);
    for (const r of rows) expect(verifyJob(keyring, r.name as JobName, r.data).ok, r.name).toBe(true);
    const seed = await vi.waitFor(
      async () => {
        const { rows: jobs } = await owner.query<{ id: string; state: string }>(`select id, state from pgboss.job where name = 'templates.seed'`);
        expect(jobs).toHaveLength(1);
        return jobs[0]!;
      },
      { timeout: 10_000 },
    );
    await settled(seed.id);
  });

  it('processes an API-enqueued job under RLS for its org, enqueued in the business transaction', async () => {
    let id: string | null = null;
    await withTenant(app.db, { orgId: a.id, actor: 'user', userId: a.user, perms: ['forms.edit'], requestId: 'req-api-1' }, async (tx) => {
      await tx.update(forms).set({ title: 'Renamed by the API' }).where(eq(forms.id, a.form));
      id = await producer.send('system.heartbeat', heartbeatFor(a), { tx: txExecutor(tx) });
    });
    expect(id).toEqual(expect.any(String));
    await settled(id!);
    expect(await auditFor(id!)).toEqual([
      {
        org_key: a.id,
        event: expect.objectContaining({ actorKind: 'system', action: 'system.heartbeat', resourceId: a.id, outcome: 'success', metadata: { attempt: 1 } }),
      },
    ]);
  });

  it('enqueues nothing when the business transaction rolls back', async () => {
    let id: string | null = null;
    const err = await withTenant(app.db, { orgId: a.id, actor: 'user', userId: a.user, requestId: 'req-api-2' }, async (tx) => {
      id = await producer.send('system.heartbeat', heartbeatFor(a), { tx: txExecutor(tx) });
      throw new Error('validation failed later');
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/validation failed later/);
    expect(id).toEqual(expect.any(String));
    expect(await jobRow(id!)).toBeUndefined();
  });

  it('runs an org job as actor system with only its perms, in the tenant of the org that owns the resource', async () => {
    const seen = deferred<Record<string, unknown>>();
    const inspect = defineJob({
      name: 'search.reindex',
      perms: ['forms.read'],
      async run({ tx }) {
        const { rows } = await tx.execute<Record<string, unknown>>(sql`select current_setting('app.org_id') as org,
          current_setting('app.actor_kind') as actor, current_setting('app.perms') as perms,
          current_setting('app.request_id') as request, (select count(*)::int from forms) as forms`);
        seen.resolve(rows[0]!);
      },
    }) as AnyJobDefinition;
    const queue = await startRuntime({ jobs: [inspect] });
    const id = await producer.send('search.reindex', { orgId: b.id, resource: { type: 'form', id: b.form }, data: { formId: b.form, reason: 'bulk_import' } });
    expect(await seen.promise).toEqual({ org: b.id, actor: 'system', perms: '{"forms.read"}', request: `job:${id}`, forms: 1 });
    await settled(id!);
    await queue.stop({ graceMs: 1000 });
  });

  it('rejects and audits forged jobs without running them, and dead-letters them', async () => {
    const stranger = producerWith(parseJobKeyring(`t1:${secret()}`));
    const unknownKey = producerWith(parseJobKeyring(`zz:${secret()}`));
    await stranger.start();
    await unknownKey.start();
    const forged = [
      { id: await stranger.send('system.heartbeat', heartbeatFor(a)), reason: 'bad_signature', orgKey: '00000000-0000-0000-0000-000000000000' },
      { id: await unknownKey.send('system.heartbeat', heartbeatFor(a)), reason: 'unknown_key', orgKey: '00000000-0000-0000-0000-000000000000' },
      // Validly signed but naming a resource of another org: the database decides, and the record goes to the owner.
      { id: await producer.send('system.heartbeat', { orgId: b.id, resource: { type: 'form', id: a.form }, data: {} }), reason: 'org_mismatch', orgKey: a.id },
      { id: await producer.send('system.heartbeat', { orgId: b.id, resource: { type: 'form', id: randomUUID() }, data: {} }), reason: 'resource_not_found', orgKey: '00000000-0000-0000-0000-000000000000' },
      { id: await producer.send('system.heartbeat', { orgId: b.id, resource: { type: 'submission', id: randomUUID() }, data: {} }), reason: 'unresolvable_resource', orgKey: '00000000-0000-0000-0000-000000000000' },
    ];
    // An arbitrary write to pgboss.job (fr_app can write it) that retargets a queued job breaks its signature.
    const tampered = await producer.send('system.heartbeat', heartbeatFor(a), { startAfter: toIsoInstant(new Date(Date.now() + 3_600_000)) });
    await app.pool.query(
      `update pgboss.job set data = jsonb_set(jsonb_set(data, '{orgId}', to_jsonb($2::text)), '{resource,id}', to_jsonb($2::text)), start_after = now() where id = $1`,
      [tampered, b.id],
    );
    forged.push({ id: tampered, reason: 'bad_signature', orgKey: '00000000-0000-0000-0000-000000000000' });

    for (const f of forged) {
      const row = await settled(f.id!, 'failed');
      expect(row.output, f.reason).toEqual({ rejected: f.reason });
      const audit = await auditFor(f.id!);
      expect(audit, f.reason).toEqual([
        { org_key: f.orgKey, event: expect.objectContaining({ actorKind: 'system', action: 'job.rejected', outcome: 'denied', reason: f.reason }) },
      ]);
      const { rows } = await owner.query<{ n: number }>(`select count(*)::int as n from pgboss.job where name = 'system.heartbeat.dead' and source_id = $1`, [f.id]);
      expect(rows[0]!.n, f.reason).toBe(1);
    }
    const mismatch = await auditFor(forged[2]!.id!);
    expect(mismatch[0]!.event.metadata).toEqual({ queue: 'system.heartbeat', jobId: forged[2]!.id, claimedOrgId: b.id });
  });

  it('partitions.maintain recreates a missing partition in parts with forced RLS and no grants', async () => {
    const { rows } = await owner.query<{ name: string }>(
      `select 'parts.audit_log_' || to_char(date_trunc('month', now() at time zone 'UTC') + interval '3 months', 'YYYY_MM') as name`,
    );
    const furthest = rows[0]!.name;
    await owner.query(`drop table ${furthest}`);
    expect((await partitionsOf(owner, 'audit_log')).map((p) => p.name)).not.toContain(furthest);
    const id = await producer.send('partitions.maintain', systemRequest('partitions.maintain'));
    await settled(id!);
    const created = (await partitionsOf(owner, 'audit_log')).find((p) => p.name === furthest);
    expect(created).toEqual({ name: furthest, forced: true, owner: 'fr_migrator', grantees: ['fr_migrator'] });
    expect(await rlsViolations(owner)).toEqual([]);
  });

  it('runs pg-boss maintenance with fr_app privileges only', async () => {
    await expect(worker.supervise()).resolves.toBeUndefined();
  });
});

describe('SIGTERM', () => {
  it('fails a running job back to the queue, and the next worker retries it', async () => {
    const attempts: number[] = [];
    const started = deferred<void>();
    let target: string | null = null;
    const slow = defineJob({
      name: 'system.heartbeat',
      perms: [],
      async run({ job }) {
        if (job.id !== target) return;
        attempts.push(job.attempt);
        if (job.attempt > 1) return;
        started.resolve();
        while (!job.signal.aborted) await new Promise((r) => setTimeout(r, 50));
        job.signal.throwIfAborted();
      },
    }) as AnyJobDefinition;

    const first = await startRuntime({ jobs: [slow] });
    target = await producer.send('system.heartbeat', systemRequest('system.heartbeat'));
    await started.promise;

    const source = new EventEmitter();
    const exit = vi.fn();
    onShutdownSignal(() => first.stop({ graceMs: 1000 }), { source: source as never, exit });
    source.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 10_000 });
    expect(await jobRow(target!)).toMatchObject({ state: 'retry' });

    await startRuntime({ jobs: [slow] });
    await settled(target!);
    expect(attempts).toEqual([1, 2]);
  });
});

afterAll(() => {
  expect(queueErrors.map((e) => e.message)).toEqual([]);
});
