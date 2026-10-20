import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createSyslogAuditSink, createWormBucketAuditSink } from '@form/adapters/audit-sink';
import { createEgressGuard } from '@form/adapters/egress';
import { createKeyfileKeyProvider } from '@form/adapters/kms';
import { createS3Storage, type S3Storage } from '@form/adapters/storage';
import { createPgBossQueue, installQueueSchema, parseJobKeyring, type JobKeyring, type PgBossQueue } from '@form/adapters/queue';
import { audit, createDb, PLATFORM_ORG_KEY, provision, verifyChain, withTenant, type DbHandle, type RoleName } from '@form/db';
import { PortError, toIsoInstant, type AuditCheckpoint, type AuditSink, type BucketName, type JobName, type PutOptions, type ReceivedJob, type Storage } from '@form/ports';
import { collectBytes, createTestDatabase, startSeaweedFs, startSyslogReceiver, type SeaweedFs } from '@form/testkit';
import { auditChainRequest, startAuditChainDispatcher, type AuditDispatcher } from '../src/audit/dispatcher.ts';
import { checkpointSigner } from '../src/audit/signatures.ts';
import { jobGuard } from '../src/guard.ts';
import { auditChain, createAuditJobs, type AnyJobDefinition, type AuditJobDeps, type JobDefinition } from '../src/jobs/index.ts';
import { runJob, startWorker } from '../src/runtime.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

const log = pino({ level: 'silent' });
const keys = createKeyfileKeyProvider({ masterKey: randomBytes(32) });
/** Chain lag budget (acceptance: < 5 s under load). A slower runner gets less load, not a wider budget. */
const LAG_BUDGET_MS = Number(process.env.FORM_AUDIT_LAG_BUDGET_MS ?? 5000);
/** Internal p95 target, well inside the budget, so a regression shows before the acceptance bound is hit. */
const LAG_P95_TARGET_MS = 3000;

let urls: Record<RoleName, string>;
let owner: pg.Pool;
let app: DbHandle;
let keyring: JobKeyring;
const queues: PgBossQueue[] = [];

interface Put {
  bucket: BucketName;
  key: string;
  body: Uint8Array;
  o: PutOptions;
}

/** Just enough of the storage port: `put` and `capabilities`, recording what was written. */
function memoryStorage(objectLock: boolean): Storage & { puts: Put[] } {
  const puts: Put[] = [];
  const unsupported = async (): Promise<never> => {
    throw new PortError('unsupported', 'not in this test store');
  };
  return {
    puts,
    async put(bucket, key, body, o) {
      if (o.objectLock && !objectLock) throw new PortError('unsupported', 'no Object Lock');
      puts.push({ bucket, key, body: body instanceof Uint8Array ? body : await collectBytes(body), o });
    },
    capabilities: async () => ({ objectLock, versioning: objectLock, sse: false }),
    presignPost: unsupported,
    presignGet: unsupported,
    head: unsupported,
    get: unsupported,
    copy: unsupported,
    delete: unsupported,
  };
}

function memorySink(): AuditSink & { forwarded: AuditCheckpoint[] } {
  const forwarded: AuditCheckpoint[] = [];
  return { kind: 'syslog', forwarded, forward: async (cp) => void forwarded.push(cp) };
}

async function newOrg(): Promise<string> {
  const id = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [id, `org-${id.slice(0, 8)}`]);
  return id;
}

const heartbeat = (orgId: string, n: number) =>
  withTenant(app.db, { orgId, actor: 'system', requestId: `load-${n}` }, (tx) =>
    audit.append(tx, orgId, { actorKind: 'system', action: 'system.heartbeat', resourceType: 'org', resourceId: orgId, outcome: 'success', metadata: { n } }),
  );

async function pending(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>('select count(*)::int as n from audit_pending');
  return rows[0]!.n;
}

/** One attempt of a system job through the runtime, without the queue. */
function systemJob<N extends JobName>(name: N, data: ReceivedJob<N>['envelope']['data']): ReceivedJob<N> {
  return {
    id: randomUUID(),
    name,
    attempt: 1,
    envelope: { v: 1, sig: 'test', orgId: null, resource: { type: 'system', id: name }, data } as ReceivedJob<N>['envelope'],
    signal: new AbortController().signal,
  };
}

function auditJobs(o: Partial<AuditJobDeps>): Record<string, JobDefinition<JobName>> {
  const worm = o.storage ? createWormBucketAuditSink({ storage: o.storage }) : undefined;
  const defs = createAuditJobs({ keys, signingKeyId: 'audit-test', requireAnchor: true, auditWriter: app.db, worm, ...o });
  return Object.fromEntries(defs.map((d) => [d.name, d as JobDefinition<JobName>]));
}

const chainAll = async () => {
  const { rows } = await owner.query<{ org_key: string }>('select distinct org_key from audit_pending');
  for (const { org_key } of rows) {
    await runJob(auditChain as JobDefinition<JobName>, { ...systemJob('audit.chain', {}), envelope: { v: 1, sig: 't', ...auditChainRequest(org_key) } } as ReceivedJob<JobName>, { db: app.db, log });
  }
};

const verifyAll = async (orgKey: string) =>
  withTenant(app.db, { orgId: orgKey, actor: 'system', requestId: 'verify', readOnly: true, isolation: 'repeatable read' }, (tx) =>
    verifyChain(tx, orgKey, { verifySignature: (cp) => checkpointSigner(keys, 'audit-test').verify(cp) }),
  );

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_audit');
  ({ urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false }));
  await installQueueSchema({ connectionString: urls.fr_migrator, appRole: 'fr_app' });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 3 });
  app = createDb(urls.fr_app, { max: 12, applicationName: 'fr-audit-test' });
  keyring = parseJobKeyring(`t1:${randomBytes(32).toString('base64url')}`);
});

afterAll(async () => {
  for (const q of queues) await q.stop({ graceMs: 1000 });
  await app?.close();
  await owner?.end();
});

describe('audit.chain on the worker', () => {
  let queue: PgBossQueue;
  let dispatcher: AuditDispatcher;
  let workerDb: DbHandle;
  const ticks: number[] = [];

  beforeAll(async () => {
    workerDb = createDb(urls.fr_app, { max: 8, applicationName: 'fr-audit-worker' });
    queue = createPgBossQueue({ connectionString: urls.fr_app, keyring, mode: 'worker', pollingIntervalSeconds: 0.5, ...jobGuard(workerDb.db, log) });
    queues.push(queue);
    await queue.start();
    await startWorker({ db: workerDb.db, log, queue, jobs: [auditChain as AnyJobDefinition] });
    dispatcher = startAuditChainDispatcher({ db: workerDb.db, queue, log, intervalMs: 250, onTick: (t) => ticks.push(t.oldestAgeMs) });
  });
  afterAll(async () => {
    await dispatcher?.stop();
    await queue?.stop({ graceMs: 1000 });
    await workerDb?.close();
  });

  it('chains org and platform events within seconds: a 403-style denial becomes an audit_log row', async () => {
    const org = await newOrg();
    await heartbeat(org, 1);
    await audit.appendDetached(app.db, org, { actorKind: 'user', actorId: randomUUID(), action: 'request.authorize', resourceType: 'route', outcome: 'denied', reason: 'missing_permission:members.manage' });
    await audit.appendDetached(app.db, null, { actorKind: 'none', action: 'request.authorize', resourceType: 'route', outcome: 'denied', reason: 'not_a_member' });
    await vi.waitFor(async () => expect(await pending()).toBe(0), { timeout: 10_000, interval: 100 });
    const { rows } = await owner.query<{ org_id: string; seq: string; action: string; outcome: string }>(
      `select org_id, seq, action, outcome from audit_log where org_id in ($1, $2) order by org_id, seq`,
      [org, PLATFORM_ORG_KEY],
    );
    expect(rows.filter((r) => r.org_id === org).map((r) => [Number(r.seq), r.action, r.outcome])).toEqual([
      [1, 'system.heartbeat', 'success'],
      [2, 'request.authorize', 'denied'],
    ]);
    expect(rows.filter((r) => r.org_id === PLATFORM_ORG_KEY).at(-1)).toMatchObject({ action: 'request.authorize', outcome: 'denied' });
    expect((await verifyAll(org)).ok).toBe(true);
    expect((await verifyAll(PLATFORM_ORG_KEY)).ok).toBe(true);
  });

  it('coalesces sends per chain and dead-letters a chain job claiming a key the database does not know', async () => {
    const org = await newOrg();
    const producer = createPgBossQueue({ connectionString: urls.fr_app, keyring, mode: 'producer' });
    queues.push(producer);
    await producer.start();
    const first = await producer.send('audit.chain', auditChainRequest(org), { singletonKey: `audit.chain:${org}`, startAfter: toIsoInstant(new Date(Date.now() + 60_000)) });
    const second = await producer.send('audit.chain', auditChainRequest(org), { singletonKey: `audit.chain:${org}` });
    expect(first).toEqual(expect.any(String));
    expect(second).toBeNull();
    const stranger = randomUUID();
    const forged = await producer.send('audit.chain', auditChainRequest(stranger), { singletonKey: `audit.chain:${stranger}` });
    await vi.waitFor(
      async () => {
        const { rows } = await owner.query<{ state: string; output: unknown }>('select state, output from pgboss.job where id = $1', [forged]);
        expect(rows[0]).toEqual({ state: 'failed', output: { rejected: 'resource_not_found' } });
      },
      { timeout: 10_000, interval: 200 },
    );
    const { rows } = await owner.query<{ n: number }>(`select count(*)::int as n from pgboss.job where name = 'audit.chain.dead' and source_id = $1`, [forged]);
    expect(rows[0]!.n).toBe(1);
  });

  it(`keeps chain lag under ${LAG_BUDGET_MS} ms while many orgs write at once`, { timeout: 120_000 }, async () => {
    const orgs = await Promise.all(Array.from({ length: 12 }, () => newOrg()));
    const committed = new Map<number, number>();
    const seen = new Map<number, number>();
    // Chain transactions of different orgs commit out of id order, so the poller filters by org, not by an id cursor.
    let polling = true;
    const poller = (async () => {
      while (polling) {
        const { rows } = await owner.query<{ n: number }>(
          `select (metadata->>'n')::int as n from audit_log where org_id = any($1::uuid[]) and action = 'system.heartbeat'`,
          [orgs],
        );
        const at = Date.now();
        for (const r of rows) if (!seen.has(r.n)) seen.set(r.n, at);
        await new Promise((r) => setTimeout(r, 50));
      }
    })();

    const total = 600;
    let next = 0;
    const producers = Array.from({ length: 8 }, async () => {
      while (next < total) {
        const n = next++;
        await heartbeat(orgs[n % orgs.length]!, 10_000 + n);
        committed.set(10_000 + n, Date.now());
      }
    });
    await Promise.all(producers);
    await vi.waitFor(() => expect(seen.size).toBeGreaterThanOrEqual(total), { timeout: 60_000, interval: 100 });
    polling = false;
    await poller;

    const lags = [...committed].map(([n, at]) => seen.get(n)! - at).sort((x, y) => x - y);
    const p95 = lags[Math.floor(lags.length * 0.95)]!;
    const max = lags.at(-1)!;
    expect(lags).toHaveLength(total);
    process.stderr.write(`audit chain lag over ${total} events: p95 ${p95} ms, max ${max} ms (budget ${LAG_BUDGET_MS} ms, p95 target ${LAG_P95_TARGET_MS} ms)\n`);
    expect(max, `chain lag p95 ${p95} ms, max ${max} ms`).toBeLessThan(LAG_BUDGET_MS);
    expect(p95, `chain lag p95 ${p95} ms, max ${max} ms`).toBeLessThan(LAG_P95_TARGET_MS);
    for (const org of orgs) expect((await verifyAll(org)).ok, org).toBe(true);
    expect(ticks.length).toBeGreaterThan(0);
  });
});

describe('audit.checkpoint', () => {
  it('signs every changed head through the KMS port and anchors it in the WORM bucket when it has Object Lock', async () => {
    const org = await newOrg();
    await heartbeat(org, 1);
    await chainAll();
    const storage = memoryStorage(true);
    const { 'audit.checkpoint': cp } = auditJobs({ storage });
    await runJob(cp!, systemJob('audit.checkpoint', {}), { db: app.db, log });
    const { rows } = await owner.query<{ seq: string; key_id: string; alg: string; anchored_object: string }>(
      'select seq, key_id, alg, anchored_object from audit_checkpoints where org_key = $1',
      [org],
    );
    expect(rows).toEqual([{ seq: '1', key_id: 'audit-test', alg: 'ed25519', anchored_object: `bucket:audit/checkpoints/${org}/${'1'.padStart(20, '0')}.json` }]);
    const put = storage.puts.find((p) => p.key.includes(org))!;
    expect(put.o.objectLock?.mode).toBe('compliance');
    expect(put.o.objectLock!.retainUntil.getTime()).toBeGreaterThan(Date.now() + 6 * 365 * 86_400_000);
    expect(JSON.parse(new TextDecoder().decode(put.body))).toMatchObject({ orgKey: org, seq: 1, alg: 'ed25519', keyId: 'audit-test' });
    const before = storage.puts.length;
    await runJob(cp!, systemJob('audit.checkpoint', {}), { db: app.db, log });
    expect(storage.puts.length).toBe(before);
    expect((await verifyAll(org)).ok).toBe(true);
  });

  it('forwards checkpoints to the syslog sink when the store has no Object Lock, and refuses to leave them unanchored', async () => {
    const org = await newOrg();
    await heartbeat(org, 1);
    await chainAll();
    const sink = memorySink();
    await runJob(auditJobs({ storage: memoryStorage(false), sink })['audit.checkpoint']!, systemJob('audit.checkpoint', {}), { db: app.db, log });
    expect(sink.forwarded.find((c) => c.orgKey === org)).toMatchObject({ seq: 1, alg: 'ed25519', signature: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/) });
    await heartbeat(org, 2);
    await chainAll();
    await expect(runJob(auditJobs({ storage: memoryStorage(false) })['audit.checkpoint']!, systemJob('audit.checkpoint', {}), { db: app.db, log })).rejects.toThrow(
      /no Object Lock and no audit sink/,
    );
    await runJob(auditJobs({ requireAnchor: false })['audit.checkpoint']!, systemJob('audit.checkpoint', {}), { db: app.db, log });
    const { rows } = await owner.query<{ seq: string; anchored_object: string | null }>('select seq, anchored_object from audit_checkpoints where org_key = $1 order by seq', [org]);
    expect(rows).toEqual([
      { seq: '1', anchored_object: `syslog:${org}/1` },
      { seq: '2', anchored_object: null },
    ]);
  });
});

describe('audit.verify', () => {
  it('records a verified event per chain, and a detached error with the first problem when a row was tampered with', async () => {
    const org = await newOrg();
    for (const n of [1, 2, 3]) await heartbeat(org, n);
    await chainAll();
    const { 'audit.verify': verify } = auditJobs({});
    await runJob(verify!, systemJob('audit.verify', {}), { db: app.db, log });
    await chainAll();
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query('alter table audit_log disable trigger user');
      await c.query(`update audit_log set reason = 'rewritten' where org_id = $1 and seq = 2`, [org]);
      await c.query('alter table audit_log enable trigger user');
      await c.query('commit');
    } finally {
      c.release();
    }
    await runJob(verify!, systemJob('audit.verify', {}), { db: app.db, log });
    const { rows } = await owner.query<{ event: { outcome: string; reason?: string; metadata: Record<string, unknown> } }>(
      `select event from audit_pending where org_key = $1 and event->>'action' = 'audit.verified' order by id`,
      [org],
    );
    expect(rows.map((r) => [r.event.outcome, r.event.reason ?? null])).toEqual([['error', 'hash_mismatch']]);
    expect(rows[0]!.event.metadata).toMatchObject({ problems: ['hash_mismatch@2'] });
    const { rows: logged } = await owner.query<{ outcome: string }>(`select outcome from audit_log where org_id = $1 and action = 'audit.verified'`, [org]);
    expect(logged).toEqual([{ outcome: 'success' }]);
  });
});

describe('audit.archive', () => {
  it('writes one NDJSON.zst object per chain with its checkpoints, records it, detaches the partition, and verify still passes', async () => {
    await owner.query(`create table parts.audit_log_2024_03 partition of audit_log for values from ('2024-03-01 00:00:00+00') to ('2024-04-01 00:00:00+00');
      alter table parts.audit_log_2024_03 enable row level security, force row level security; revoke all on parts.audit_log_2024_03 from public`);
    const org = await newOrg();
    await owner.query(
      `insert into audit_pending (org_key, event, occurred_at) select $1, $2, timestamptz '2024-03-10 08:00:00+00' + make_interval(mins => i) from generate_series(1, 4) i`,
      [org, { actorKind: 'system', action: 'system.heartbeat', resourceType: 'org', outcome: 'success' }],
    );
    await chainAll();
    await runJob(auditJobs({ requireAnchor: false })['audit.checkpoint']!, systemJob('audit.checkpoint', {}), { db: app.db, log });
    await heartbeat(org, 1);
    await chainAll();
    const storage = memoryStorage(false);
    await expect(runJob(auditJobs({ storage })['audit.archive']!, systemJob('audit.archive', { month: '2024-03' }), { db: app.db, log })).rejects.toThrow(/no Object Lock/);
    expect(storage.puts).toEqual([]);
    const { 'audit.archive': archive } = auditJobs({ storage, requireAnchor: false });
    await expect(runJob(archive!, systemJob('audit.archive', { month: '2026-09' }), { db: app.db, log })).rejects.toThrow(/online window/);
    await runJob(archive!, systemJob('audit.archive', { month: '2024-03' }), { db: app.db, log });

    const put = storage.puts.find((p) => p.key === `archive/${org}/2024-03.ndjson.zst`)!;
    expect(put.o).toEqual({ contentType: 'application/zstd' });
    const lines = zstdDecompressSync(put.body)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { seq?: number; hash?: string; prevHash?: string; checkpoint?: AuditCheckpoint });
    expect(lines.map((l) => l.seq ?? 'checkpoint')).toEqual([1, 2, 3, 4, 'checkpoint']);
    expect(lines[1]!.prevHash).toBe(lines[0]!.hash);
    expect(lines[4]!.checkpoint).toMatchObject({ orgKey: org, seq: 4, hash: lines[3]!.hash, keyId: 'audit-test' });
    const { rows: archived } = await owner.query<{ row_count: string; min_seq: string; max_seq: string }>(
      'select row_count, min_seq, max_seq from audit_archives where org_key = $1',
      [org],
    );
    expect(archived).toEqual([{ row_count: '4', min_seq: '1', max_seq: '4' }]);
    const { rows: attached } = await owner.query(`select 1 from pg_inherits where inhrelid = 'parts.audit_log_2024_03'::regclass`);
    expect(attached).toEqual([]);
    await chainAll();
    expect(await verifyAll(org)).toMatchObject({ ok: true, archivedRows: 4, rowsChecked: 2 });
  });

  it('archives and detaches every attached month outside the window on a cron run, oldest first (BL-196)', async () => {
    const org = await newOrg();
    for (const month of ['2023_11', '2023_12']) {
      const [y, m] = month.split('_').map(Number) as [number, number];
      const from = `${y}-${String(m).padStart(2, '0')}-01`;
      const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
      await owner.query(`create table parts.audit_log_${month} partition of audit_log for values from ('${from} 00:00:00+00') to ('${to} 00:00:00+00');
        alter table parts.audit_log_${month} enable row level security, force row level security; revoke all on parts.audit_log_${month} from public`);
      await owner.query(`insert into audit_pending (org_key, event, occurred_at) values ($1, $2, $3::timestamptz + interval '3 days')`, [
        org,
        { actorKind: 'system', action: 'system.heartbeat', resourceType: 'org', outcome: 'success' },
        `${from} 00:00:00+00`,
      ]);
    }
    await chainAll();
    const storage = memoryStorage(false);
    await runJob(auditJobs({ storage, requireAnchor: false })['audit.archive']!, systemJob('audit.archive', {}), { db: app.db, log });
    expect(storage.puts.map((p) => p.key)).toEqual([`archive/${org}/2023-11.ndjson.zst`, `archive/${org}/2023-12.ndjson.zst`]);
    const { rows } = await owner.query(`select 1 from pg_inherits where inhrelid in ('parts.audit_log_2023_11'::regclass, 'parts.audit_log_2023_12'::regclass)`);
    expect(rows).toEqual([]);
    expect(await verifyAll(org)).toMatchObject({ ok: true, archivedRows: 2 });
  });
});

/** BL-179 and the WP-1.03 acceptance: the same jobs against the S3 adapter on SeaweedFS, with and without Object Lock. */
describe('audit anchoring on S3 (SeaweedFS)', () => {
  let s3: SeaweedFs;
  const egress = createEgressGuard({ policy: 'allowlist', allowlist: ['127.0.0.1', 'localhost'] });

  beforeAll(async () => {
    s3 = await startSeaweedFs();
  });
  afterAll(() => s3?.stop());

  async function bucketStore(objectLockAudit: boolean): Promise<S3Storage> {
    const prefix = `fr${randomBytes(4).toString('hex')}`;
    const storage = createS3Storage({
      region: 'us-east-1',
      endpoint: s3.endpoint,
      credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
      buckets: { staging: `${prefix}-staging`, uploads: `${prefix}-uploads`, assets: `${prefix}-assets`, exports: `${prefix}-exports`, audit: `${prefix}-audit`, packs: `${prefix}-packs` },
      egress,
    });
    await storage.ensureBuckets({ objectLockAudit });
    return storage;
  }

  it('anchors checkpoints and archives in a compliance-locked bucket, and the archive hashes to what was recorded', async () => {
    await owner.query(`create table parts.audit_log_2024_05 partition of audit_log for values from ('2024-05-01 00:00:00+00') to ('2024-06-01 00:00:00+00');
      alter table parts.audit_log_2024_05 enable row level security, force row level security; revoke all on parts.audit_log_2024_05 from public`);
    const org = await newOrg();
    await owner.query(
      `insert into audit_pending (org_key, event, occurred_at) select $1, $2, timestamptz '2024-05-10 08:00:00+00' + make_interval(mins => i) from generate_series(1, 3) i`,
      [org, { actorKind: 'system', action: 'system.heartbeat', resourceType: 'org', outcome: 'success' }],
    );
    await chainAll();
    const storage = await bucketStore(true);
    expect((await storage.capabilities()).objectLock).toBe(true);
    const jobs = auditJobs({ storage });
    await runJob(jobs['audit.checkpoint']!, systemJob('audit.checkpoint', {}), { db: app.db, log });
    const checkpoint = JSON.parse(new TextDecoder().decode(await collectBytes(await storage.get('audit', `checkpoints/${org}/${'3'.padStart(20, '0')}.json`))));
    expect(checkpoint).toMatchObject({ orgKey: org, seq: 3, keyId: 'audit-test', alg: 'ed25519' });

    await runJob(jobs['audit.archive']!, systemJob('audit.archive', { month: '2024-05' }), { db: app.db, log });
    const body = await collectBytes(await storage.get('audit', `archive/${org}/2024-05.ndjson.zst`));
    const { rows } = await owner.query<{ sha256: Buffer; row_count: string }>('select sha256, row_count from audit_archives where org_key = $1', [org]);
    expect(rows[0]?.row_count).toBe('3');
    expect(createHash('sha256').update(body).digest().equals(rows[0]!.sha256)).toBe(true);
    expect(zstdDecompressSync(body).toString('utf8').trim().split('\n')).toHaveLength(4);
    await chainAll();
    expect(await verifyAll(org)).toMatchObject({ ok: true, archivedRows: 3 });
  });

  it('sends checkpoints to the syslog sink when the bucket has no Object Lock, and writes none to the bucket', async () => {
    const org = await newOrg();
    await heartbeat(org, 1);
    await chainAll();
    const storage = await bucketStore(false);
    expect((await storage.capabilities()).objectLock).toBe(false);
    const siem = await startSyslogReceiver();
    try {
      const sink = createSyslogAuditSink({ url: siem.url, egress: createEgressGuard({ policy: 'none', trusted: ['127.0.0.1'] }) });
      await runJob(auditJobs({ storage, sink })['audit.checkpoint']!, systemJob('audit.checkpoint', {}), { db: app.db, log });
      expect((await siem.received()).filter((c) => c.orgKey === org)).toEqual([expect.objectContaining({ orgKey: org, seq: 1, keyId: 'audit-test' })]);
      expect(await storage.head('audit', `checkpoints/${org}/${'1'.padStart(20, '0')}.json`)).toBeNull();
      const { rows } = await owner.query<{ anchored_object: string }>('select anchored_object from audit_checkpoints where org_key = $1', [org]);
      expect(rows).toEqual([{ anchored_object: `syslog:${org}/1` }]);
    } finally {
      await siem.close();
    }
  });
});
