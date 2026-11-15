import { withTenant, type Db, type TenantCtx, type Tx } from '@form/db';
import type { JobName, JobRequest, Queue, ReceivedJob, SystemJobName, Worker } from '@form/ports';
import type { Logger } from 'pino';
import { JOB_DEFINITIONS, type AnyJobDefinition, type InTenant, type JobContext, type JobDefinition, type ManualJobContext } from './jobs/index.ts';

export interface RunDeps {
  db: Db;
  log: Logger;
}

/**
 * One attempt. Org jobs run in `withTenant` as actor `system` with the job's perms; the tenant transaction
 * commits only if the attempt was not interrupted, so a job failed back to the queue by a shutdown leaves no
 * half-done work behind.
 *
 * A `transaction: 'manual'` org job gets no transaction: it gets `inTenant(fn)`, which is that same `withTenant` (same
 * org, actor, perms and request id) for one unit of work at a time, so an SMTP or HTTP call between two units holds no
 * database connection. Each unit commits on its own and, like the single transaction, is rolled back when the attempt
 * was interrupted.
 */
export async function runJob<N extends JobName>(def: JobDefinition<N>, job: ReceivedJob<N>, deps: RunDeps): Promise<void> {
  const { orgId } = job.envelope;
  const log = deps.log.child({ queue: job.name, jobId: job.id, attempt: job.attempt, ...(orgId !== null ? { orgId } : {}) });
  const started = performance.now();
  try {
    job.signal.throwIfAborted();
    if (orgId === null) {
      // Both kinds of definition run a system job the same way: no tenant, so there is nothing to open.
      await def.run({ kind: 'system', job, log, db: deps.db } as JobContext<N> & ManualJobContext<N>);
    } else {
      const tenant: TenantCtx = { orgId, actor: 'system', requestId: `job:${job.id}`, perms: def.perms };
      if (def.transaction === 'manual') {
        const inTenant: InTenant = async (fn) => {
          job.signal.throwIfAborted();
          return withTenant(deps.db, tenant, async (tx: Tx) => {
            const result = await fn(tx);
            job.signal.throwIfAborted();
            return result;
          });
        };
        await def.run({ kind: 'org', job, log, orgId, inTenant } as ManualJobContext<N>);
      } else {
        await withTenant(deps.db, tenant, async (tx) => {
          await def.run({ kind: 'org', job, log, orgId, tx } as JobContext<N>);
          job.signal.throwIfAborted();
        });
      }
    }
    log.info({ ms: Math.round(performance.now() - started) }, 'job done');
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    if (job.signal.aborted) log.warn({ ms }, 'job interrupted; it will be retried');
    else log.error({ err, ms }, 'job failed');
    throw err;
  }
}

/** Definitions whose queue matches a name or a `prefix.*` pattern; every pattern must match something. */
export function selectJobs(defs: readonly AnyJobDefinition[], patterns: readonly string[] | undefined): AnyJobDefinition[] {
  if (!patterns) return [...defs];
  const matches = (p: string, name: string) => (p.endsWith('.*') ? name.startsWith(p.slice(0, -1)) : name === p);
  for (const p of patterns) {
    if (!defs.some((d) => matches(p, d.name))) throw new Error(`WORKER_QUEUES: ${p} matches no queue with a handler`);
  }
  return defs.filter((d) => patterns.some((p) => matches(p, d.name)));
}

export interface WorkerOptions extends RunDeps {
  queue: Queue;
  jobs?: readonly AnyJobDefinition[] | undefined;
  queues?: readonly string[] | undefined;
  /** Enqueue `templates.seed` once at boot when this worker serves it. */
  seedTemplates?: boolean | undefined;
}

export interface StartedWorker {
  queues: JobName[];
  /** Stops fetching for these queues; the queue itself (and running jobs) is stopped by its owner. */
  stop(): Promise<void>;
}

const systemRequest = (name: JobName) => ({ orgId: null, resource: { type: 'system' as const, id: name }, data: {} });

/** Registers a handler per selected queue, schedules their cron, and kicks off seeding. */
export async function startWorker(o: WorkerOptions): Promise<StartedWorker> {
  const defs = selectJobs(o.jobs ?? JOB_DEFINITIONS, o.queues);
  const workers: Worker[] = [];
  for (const def of defs as JobDefinition<JobName>[]) {
    workers.push(await o.queue.work(def.name, (job) => runJob(def, job, o), def.pollIntervalMs ? { pollIntervalMs: def.pollIntervalMs } : {}));
    if (def.cron) await o.queue.schedule(def.name as SystemJobName, def.cron, systemRequest(def.name) as JobRequest<SystemJobName>);
  }
  if (o.seedTemplates && defs.some((d) => d.name === 'templates.seed')) {
    await o.queue.send('templates.seed', systemRequest('templates.seed'), { singletonKey: 'templates.seed' });
  }
  o.log.info({ queues: defs.map((d) => d.name) }, 'worker started');
  return {
    queues: defs.map((d) => d.name),
    async stop() {
      await Promise.all(workers.map((w) => w.stop()));
    },
  };
}
