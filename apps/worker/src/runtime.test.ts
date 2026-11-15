import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Db } from '@form/db';
import { JOBS, type JobHandler, type JobName, type KeyProvider, type Queue, type ReceivedJob } from '@form/ports';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { EffectDeps } from './effects/deps.ts';
import { createAuditJobs, createEffectFanout, createEffectJobs, defineJob, JOB_DEFINITIONS, submissionFanout, type AnyJobDefinition } from './jobs/index.ts';
import { runJob, selectJobs, startWorker } from './runtime.ts';

const log = pino({ level: 'silent' });
const db = { execute: vi.fn() } as unknown as Db;
const auditDefs = createAuditJobs({
  keys: {} as KeyProvider,
  signingKeyId: 'audit-v1',
  storage: {} as never,
  requireAnchor: true,
  auditWriter: db,
});

function received<N extends JobName>(name: N, signal: AbortSignal = new AbortController().signal): ReceivedJob<N> {
  return {
    id: randomUUID(),
    name,
    attempt: 1,
    signal,
    envelope: { v: 1, orgId: null, resource: { type: 'system', id: name }, data: {}, sig: 'k.x' } as never,
  };
}

function fakeQueue() {
  const handlers = new Map<string, JobHandler<JobName>>();
  const calls: unknown[][] = [];
  const queue: Queue = {
    send: vi.fn(async (...args: unknown[]) => {
      calls.push(['send', ...args]);
      return 'id';
    }) as Queue['send'],
    work: vi.fn(async (name: JobName, handler: JobHandler<JobName>, o?: object) => {
      handlers.set(name, handler);
      calls.push(o && Object.keys(o).length > 0 ? ['work', name, o] : ['work', name]);
      return { stop: async () => void calls.push(['stop', name]) };
    }) as Queue['work'],
    schedule: vi.fn(async (...args: unknown[]) => void calls.push(['schedule', ...args])) as Queue['schedule'],
    unschedule: vi.fn(async () => {}),
  };
  return { queue, handlers, calls };
}

describe('the job registry', () => {
  it('has one definition per queue, minimal perms, and cron only where a run needs no tenant', () => {
    const names = JOB_DEFINITIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(['system.heartbeat', 'partitions.maintain', 'templates.seed', 'audit.chain', 'submission.fanout']);
    for (const d of [...JOB_DEFINITIONS, ...auditDefs]) {
      expect(d.perms, d.name).toEqual([]);
      if (d.cron) {
        expect(JOBS[d.name].scope, d.name).not.toBe('org');
        expect(d.cron.split(' '), d.name).toHaveLength(5);
      }
    }
  });
});

describe('the effect jobs', () => {
  // The stubs of notifications, webhooks and exports read nothing from the deps yet; the work packages that fill them do.
  const deps = {} as EffectDeps;

  it('never register a queue the registry or the audit jobs already serve, and replace the consumerless fan-out under its own name', () => {
    const fanout = createEffectFanout(deps);
    expect(fanout).toMatchObject({ name: 'submission.fanout', perms: [] });
    expect(fanout).not.toBe(submissionFanout);
    const names = [...JOB_DEFINITIONS.filter((d) => d !== submissionFanout), fanout, ...createEffectJobs(deps), ...auditDefs].map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('start in a worker beside the registry with the fan-out swapped, one handler for submission.fanout', async () => {
    const { queue, calls } = fakeQueue();
    const jobs = [...JOB_DEFINITIONS.filter((d) => d.name !== 'submission.fanout'), createEffectFanout(deps), ...createEffectJobs(deps)];
    const w = await startWorker({ db, log, queue, jobs });
    expect(w.queues.filter((n) => n === 'submission.fanout')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'work' && c[1] === 'submission.fanout')).toHaveLength(1);
  });
});

describe('the audit jobs', () => {
  it('serve checkpoint and verify, and archive only with storage, on hourly, daily and monthly cron', () => {
    expect(auditDefs.map((d) => [d.name, d.cron])).toEqual([
      ['audit.checkpoint', '5 * * * *'],
      ['audit.verify', '30 2 * * *'],
      ['audit.archive', '0 3 2 * *'],
    ]);
    const withoutStorage = createAuditJobs({ keys: {} as KeyProvider, signingKeyId: 'a', requireAnchor: false, auditWriter: db });
    expect(withoutStorage.map((d) => d.name)).toEqual(['audit.checkpoint', 'audit.verify']);
  });
});

describe('selectJobs', () => {
  it('selects by name or prefix and refuses patterns that match nothing', () => {
    expect(selectJobs(JOB_DEFINITIONS, undefined)).toHaveLength(5);
    expect(selectJobs(JOB_DEFINITIONS, ['templates.*']).map((d) => d.name)).toEqual(['templates.seed']);
    expect(selectJobs(JOB_DEFINITIONS, ['system.heartbeat', 'partitions.maintain']).map((d) => d.name)).toEqual([
      'system.heartbeat',
      'partitions.maintain',
    ]);
    expect(() => selectJobs(JOB_DEFINITIONS, ['pdf.*'])).toThrow(/pdf\.\* matches no queue/);
    expect(() => selectJobs(JOB_DEFINITIONS, ['templates'])).toThrow(/matches no queue/);
  });
});

describe('startWorker', () => {
  it('works each selected queue, schedules its cron in UTC and enqueues seeding once', async () => {
    const { queue, calls } = fakeQueue();
    const w = await startWorker({ db, log, queue, seedTemplates: true });
    expect(w.queues).toEqual(['system.heartbeat', 'partitions.maintain', 'templates.seed', 'audit.chain', 'submission.fanout']);
    const system = (id: string) => ({ orgId: null, resource: { type: 'system', id }, data: {} });
    expect(calls).toEqual([
      ['work', 'system.heartbeat'],
      ['schedule', 'system.heartbeat', '*/5 * * * *', system('system.heartbeat')],
      ['work', 'partitions.maintain'],
      ['schedule', 'partitions.maintain', '15 0 * * *', system('partitions.maintain')],
      ['work', 'templates.seed'],
      ['work', 'audit.chain', { pollIntervalMs: 500 }],
      ['work', 'submission.fanout'],
      ['send', 'templates.seed', system('templates.seed'), { singletonKey: 'templates.seed' }],
    ]);
    await w.stop();
    expect(calls.slice(-5).map((c) => c[0])).toEqual(['stop', 'stop', 'stop', 'stop', 'stop']);
  });

  it('does not seed when told not to or when another worker serves templates.seed', async () => {
    for (const o of [{ seedTemplates: false }, { seedTemplates: true, queues: ['system.heartbeat'] }]) {
      const { queue, calls } = fakeQueue();
      await startWorker({ db, log, queue, ...o });
      expect(calls.filter((c) => c[0] === 'send')).toEqual([]);
    }
  });

  it('routes received jobs to their definition', async () => {
    const run = vi.fn(async () => {});
    const custom = defineJob({ name: 'templates.seed', perms: [], run }) as AnyJobDefinition;
    const { queue, handlers } = fakeQueue();
    await startWorker({ db, log, queue, jobs: [custom] });
    const job = received('templates.seed');
    await handlers.get('templates.seed')!(job);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ kind: 'system', job, db }));
  });
});

describe('runJob', () => {
  it('runs system jobs on the pool, outside any tenant', async () => {
    const run = vi.fn(async () => {});
    await runJob(defineJob({ name: 'partitions.maintain', perms: [], run }), received('partitions.maintain'), { db, log });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ kind: 'system', db }));
  });

  it('does not start an attempt that was already interrupted, and rethrows failures for a retry', async () => {
    const run = vi.fn(async () => {});
    const ac = new AbortController();
    ac.abort(new Error('shutting down'));
    await expect(runJob(defineJob({ name: 'partitions.maintain', perms: [], run }), received('partitions.maintain', ac.signal), { db, log })).rejects.toThrow(
      'shutting down',
    );
    expect(run).not.toHaveBeenCalled();
    const failing = defineJob({ name: 'partitions.maintain', perms: [], run: async () => Promise.reject(new Error('boom')) });
    await expect(runJob(failing, received('partitions.maintain'), { db, log })).rejects.toThrow('boom');
  });
});

/** A `Db` whose transactions run in memory: records the `set_config` parameters `withTenant` sets and how many transactions are open at once. */
function tenantDb() {
  const dialect = new PgDialect();
  const settings: unknown[][] = [];
  let open = 0;
  const tx = {
    execute: vi.fn(async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      settings.push(dialect.sqlToQuery(query).params);
      return { rows: [] };
    }),
  };
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    open += 1;
    try {
      return await fn(tx);
    } finally {
      open -= 1;
    }
  });
  return { db: { transaction } as unknown as Db, transaction, tx, settings, open: () => open };
}

function receivedFor<N extends JobName>(name: N, orgId: string, signal: AbortSignal = new AbortController().signal): ReceivedJob<N> {
  return { ...received(name, signal), envelope: { v: 1, orgId, resource: { type: 'form', id: randomUUID() }, data: {}, sig: 'k.x' } as never };
}

describe('runJob: transaction "manual" (WP-1.16, WP-1.18)', () => {
  const orgId = randomUUID();

  it('gives a manual org job inTenant and no tx, and opens no transaction until it asks for one', async () => {
    const t = tenantDb();
    const seen: Record<string, unknown>[] = [];
    const def = defineJob({
      name: 'search.reindex',
      perms: ['forms.read'],
      transaction: 'manual',
      async run(ctx) {
        seen.push({ ...ctx });
        expect(t.transaction).not.toHaveBeenCalled();
      },
    });
    const job = receivedFor('search.reindex', orgId);
    await runJob(def, job, { db: t.db, log });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'org', orgId, job });
    expect(typeof seen[0]!['inTenant']).toBe('function');
    expect('tx' in seen[0]!).toBe(false);
    expect(t.transaction).not.toHaveBeenCalled();
  });

  it('runs each inTenant as actor system with the definition’s perms and request id job:<id>, one transaction per call, none open in between', async () => {
    const t = tenantDb();
    const job = receivedFor('search.reindex', orgId);
    const between: number[] = [];
    const def = defineJob({
      name: 'search.reindex',
      perms: ['forms.read', 'submissions.read'],
      transaction: 'manual',
      async run(ctx) {
        if (ctx.kind !== 'org') throw new Error('expected an org context');
        expect(await ctx.inTenant(async (tx) => (tx === (t.tx as unknown) ? 'first' : 'other'))).toBe('first');
        between.push(t.open());
        await ctx.inTenant(async () => {
          expect(t.open()).toBe(1);
        });
        between.push(t.open());
      },
    });
    await runJob(def, job, { db: t.db, log });
    expect(t.transaction).toHaveBeenCalledTimes(2);
    for (const params of t.settings) {
      expect(params).toEqual([orgId, '', '{}', '{"forms.read","submissions.read"}', 'system', '{}', `job:${job.id}`]);
    }
    expect(between).toEqual([0, 0]);
  });

  it('keeps a "job" definition as it was: one transaction for the whole attempt, handed over as tx', async () => {
    const t = tenantDb();
    const run = vi.fn(async (_ctx: unknown) => {});
    await runJob(defineJob({ name: 'search.reindex', perms: ['forms.read'], run }), receivedFor('search.reindex', orgId), { db: t.db, log });
    expect(t.transaction).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ kind: 'org', orgId, tx: t.tx }));
    expect(run.mock.calls[0]![0]).not.toHaveProperty('inTenant');
  });

  it('gives a manual job with no org (a scope "any" queue) the same system context as any other job', async () => {
    const t = tenantDb();
    const seen: unknown[] = [];
    const def = defineJob({
      name: 'email.send',
      perms: [],
      transaction: 'manual',
      async run(ctx) {
        seen.push(ctx.kind === 'system' ? ctx.db : ctx);
      },
    });
    await runJob(def, received('email.send'), { db: t.db, log });
    expect(seen).toEqual([t.db]);
    expect(t.transaction).not.toHaveBeenCalled();
  });

  it('rolls a unit back when its attempt was interrupted, and starts no new unit after that', async () => {
    const t = tenantDb();
    const ac = new AbortController();
    const reason = new Error('shutting down');
    let second: unknown;
    const def = defineJob({
      name: 'search.reindex',
      perms: [],
      transaction: 'manual',
      async run(ctx) {
        if (ctx.kind !== 'org') throw new Error('expected an org context');
        const first = await ctx
          .inTenant(async () => {
            ac.abort(reason);
          })
          .catch((e: unknown) => e);
        expect(first).toBe(reason);
        second = await ctx.inTenant(async () => 'ran').catch((e: unknown) => e);
      },
    });
    await expect(runJob(def, receivedFor('search.reindex', orgId, ac.signal), { db: t.db, log })).resolves.toBeUndefined();
    expect(second).toBe(reason);
    // The first unit opened a transaction (and threw inside it, which rolls it back); the second never opened one.
    expect(t.transaction).toHaveBeenCalledTimes(1);
  });
});
