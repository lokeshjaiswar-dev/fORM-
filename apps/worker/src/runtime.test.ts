import { randomUUID } from 'node:crypto';
import type { Db } from '@form/db';
import { JOBS, type JobHandler, type JobName, type KeyProvider, type Queue, type ReceivedJob } from '@form/ports';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createAuditJobs, defineJob, JOB_DEFINITIONS, type AnyJobDefinition } from './jobs/index.ts';
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
    expect(names).toEqual(['system.heartbeat', 'partitions.maintain', 'templates.seed', 'audit.chain']);
    for (const d of [...JOB_DEFINITIONS, ...auditDefs]) {
      expect(d.perms, d.name).toEqual([]);
      if (d.cron) {
        expect(JOBS[d.name].scope, d.name).not.toBe('org');
        expect(d.cron.split(' '), d.name).toHaveLength(5);
      }
    }
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
    expect(selectJobs(JOB_DEFINITIONS, undefined)).toHaveLength(4);
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
    expect(w.queues).toEqual(['system.heartbeat', 'partitions.maintain', 'templates.seed', 'audit.chain']);
    const system = (id: string) => ({ orgId: null, resource: { type: 'system', id }, data: {} });
    expect(calls).toEqual([
      ['work', 'system.heartbeat'],
      ['schedule', 'system.heartbeat', '*/5 * * * *', system('system.heartbeat')],
      ['work', 'partitions.maintain'],
      ['schedule', 'partitions.maintain', '15 0 * * *', system('partitions.maintain')],
      ['work', 'templates.seed'],
      ['work', 'audit.chain', { pollIntervalMs: 500 }],
      ['send', 'templates.seed', system('templates.seed'), { singletonKey: 'templates.seed' }],
    ]);
    await w.stop();
    expect(calls.slice(-4).map((c) => c[0])).toEqual(['stop', 'stop', 'stop', 'stop']);
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
