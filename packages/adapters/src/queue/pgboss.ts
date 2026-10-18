import { PgBoss, type JobResult, type Queue as BossQueueConfig } from 'pg-boss';
import {
  isPortError,
  JOB_POLICIES,
  JOBS,
  PortError,
  type JobName,
  type JobPolicy,
  type JobResource,
  type Queue,
  type ReceivedJob,
} from '@form/ports';
import { signJob, verifyJob, type EnvelopeRejection, type JobKeyring } from './envelope.ts';

/** pg-boss lives in its own schema; its tables hold ids only and are outside RLS (architecture §5.1). */
export const QUEUE_SCHEMA = 'pgboss';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** Every queue's dead letters: retries spent, or an envelope that failed verification. */
export const deadLetterQueue = (name: JobName): string => `${name}.dead`;

const JOB_NAMES = Object.keys(JOBS) as JobName[];

export type JobRejection = EnvelopeRejection | 'resource_not_found' | 'org_mismatch' | 'unresolvable_resource';

export interface RejectedJob {
  id: string;
  name: JobName;
  reason: JobRejection;
  /** What the envelope claimed; untrusted. */
  claimedOrgId: string | null;
  resource: JobResource | null;
  /** The owner of the resource according to the database, when it could be resolved. */
  resolvedOrgId: string | null;
}

export interface PgBossQueueOptions {
  connectionString: string;
  keyring: JobKeyring;
  schema?: string;
  /** `producer` only sends (api); `worker` also supervises the queues, runs cron and works jobs. */
  mode: 'producer' | 'worker';
  max?: number;
  applicationName?: string;
  /** How often an idle worker polls a queue (default 2 s). */
  pollingIntervalSeconds?: number;
  /**
   * The org that owns a resource (`resolve_job_org`), or null when the resource does not exist. Throw
   * `PortError('unsupported')` for a resource type the database cannot resolve. Required to work jobs.
   */
  resolveOrg?: (resource: JobResource) => Promise<string | null>;
  /** Called (and awaited) before a rejected job is dead-lettered without running; audit it here. A throw retries the job. */
  onRejected?: (job: RejectedJob) => Promise<void>;
  onError?: (err: Error) => void;
}

export interface PgBossQueue extends Queue {
  start(): Promise<void>;
  /**
   * Stops fetching, waits up to `graceMs` (default 30 s, at least 1 s) for running handlers, then fails what is
   * still running, so those jobs retry, aborts their signals and closes the pool.
   */
  stop(o?: { graceMs?: number }): Promise<void>;
  /** One maintenance pass now (expiry, retention, dead letters); a worker also runs them on a timer. */
  supervise(): Promise<void>;
}

function queueOptions(p: JobPolicy): Omit<BossQueueConfig, 'name'> {
  return {
    retryLimit: p.retryLimit,
    retryDelay: p.retryDelaySeconds,
    retryBackoff: p.retryBackoff,
    ...(p.retryBackoff ? { retryDelayMax: p.retryDelayMaxSeconds } : {}),
    expireInSeconds: p.expireInSeconds,
  };
}

function checkSchema(schema: string): string {
  if (!IDENTIFIER.test(schema)) throw new PortError('invalid_argument', `invalid queue schema ${JSON.stringify(schema)}`);
  return schema;
}

/** pg-boss on Postgres (architecture §5): signs every envelope it sends and verifies every one it hands out. */
export function createPgBossQueue(o: PgBossQueueOptions): PgBossQueue {
  const worker = o.mode === 'worker';
  const boss = new PgBoss({
    connectionString: o.connectionString,
    schema: checkSchema(o.schema ?? QUEUE_SCHEMA),
    max: o.max ?? 10,
    application_name: o.applicationName ?? `fr-queue-${o.mode}`,
    // The schema is installed by installQueueSchema() as its owner; the app role only reads and writes rows.
    migrate: false,
    createSchema: false,
    supervise: worker,
    schedule: worker,
    reindex: false,
    instanceName: o.applicationName ?? `fr-${o.mode}`,
  });
  boss.on('error', (err: Error) => o.onError?.(err));

  async function admit<N extends JobName>(
    resolveOrg: NonNullable<PgBossQueueOptions['resolveOrg']>,
    name: N,
    id: string,
    data: unknown,
  ): Promise<{ envelope: ReceivedJob<N>['envelope'] } | RejectedJob> {
    const rejected = (reason: JobRejection, extra: Partial<RejectedJob> = {}): RejectedJob => ({
      id,
      name,
      reason,
      claimedOrgId: null,
      resource: null,
      resolvedOrgId: null,
      ...extra,
    });
    const check = verifyJob(o.keyring, name, data);
    if (!check.ok) return rejected(check.reason);
    const { envelope } = check;
    const claim = { claimedOrgId: envelope.orgId as string | null, resource: envelope.resource };
    if (envelope.orgId === null) return { envelope };
    let resolvedOrgId: string | null;
    try {
      resolvedOrgId = await resolveOrg(envelope.resource);
    } catch (err) {
      if (isPortError(err, 'unsupported')) return rejected('unresolvable_resource', claim);
      throw err;
    }
    if (resolvedOrgId === null) return rejected('resource_not_found', claim);
    if (resolvedOrgId !== envelope.orgId) return rejected('org_mismatch', { ...claim, resolvedOrgId });
    return { envelope };
  }

  return {
    async start() {
      await boss.start();
    },

    async stop(s = {}) {
      await boss.stop({ graceful: true, timeout: s.graceMs ?? 30_000, close: true });
    },

    async supervise() {
      await boss.supervise();
    },

    async send(name, job, s = {}) {
      return boss.send(name, signJob(o.keyring, name, job), {
        ...(s.singletonKey !== undefined ? { singletonKey: s.singletonKey } : {}),
        ...(s.startAfter !== undefined ? { startAfter: s.startAfter } : {}),
        ...(s.tx ? { db: s.tx } : {}),
      });
    },

    async work(name, handler, w = {}) {
      if (!worker) throw new PortError('unsupported', 'a producer queue does not work jobs');
      const { resolveOrg, onRejected } = o;
      if (!resolveOrg || !onRejected) throw new PortError('unsupported', 'working jobs needs resolveOrg and onRejected (ADR-0016)');
      const id = await boss.work(
        name,
        {
          batchSize: 1,
          localConcurrency: w.concurrency ?? JOB_POLICIES[name].concurrency,
          pollingIntervalSeconds: o.pollingIntervalSeconds ?? 2,
          perJobResults: true,
        },
        async (jobs): Promise<JobResult[]> => {
          const results: JobResult[] = [];
          for (const job of jobs) {
            const admitted = await admit(resolveOrg, name, job.id, job.data);
            if (!('envelope' in admitted)) {
              await onRejected(admitted);
              results.push({ id: job.id, status: 'deadletter', output: { rejected: admitted.reason } });
              continue;
            }
            await handler({ id: job.id, name, attempt: job.retryCount + 1, envelope: admitted.envelope, signal: job.signal });
            results.push({ id: job.id, status: 'completed' });
          }
          return results;
        },
      );
      return { stop: () => boss.offWork(name, { id, wait: true }) };
    },

    async schedule(name, cron, job) {
      await boss.schedule(name, cron, signJob(o.keyring, name, job), { tz: 'UTC' });
    },

    async unschedule(name) {
      await boss.unschedule(name);
    },
  };
}

export interface InstallQueueOptions {
  /** A role that may create the schema: the migrator, which then owns it. */
  connectionString: string;
  /** Gets row access to every pg-boss table and EXECUTE on its functions (fr_app). */
  appRole: string;
  schema?: string;
  /** Per-queue changes to `JOB_POLICIES` (tests, operators). */
  policies?: { readonly [N in JobName]?: Partial<JobPolicy> };
}

/**
 * Installs or upgrades the pg-boss schema, creates every queue of `JOBS` with its policy and dead-letter queue
 * (existing queues get the current retry settings), and grants the app role row access. Runs with the
 * migrations (`pnpm dev:setup`, the migrate Job), never from request traffic.
 */
export async function installQueueSchema(o: InstallQueueOptions): Promise<{ queues: string[] }> {
  const schema = checkSchema(o.schema ?? QUEUE_SCHEMA);
  if (!IDENTIFIER.test(o.appRole)) throw new PortError('invalid_argument', `invalid role ${JSON.stringify(o.appRole)}`);
  const boss = new PgBoss({
    connectionString: o.connectionString,
    schema,
    max: 2,
    application_name: 'fr-queue-install',
    migrate: true,
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
  const errors: Error[] = [];
  boss.on('error', (err: Error) => errors.push(err));
  await boss.start();
  try {
    const ensure = async (name: string, options: Omit<BossQueueConfig, 'name'>) => {
      if (await boss.getQueue(name)) {
        const { policy: _policy, ...updatable } = options;
        await boss.updateQueue(name, { retryDelayMax: null, ...updatable });
      } else {
        await boss.createQueue(name, options);
      }
    };
    const queues: string[] = [];
    for (const name of JOB_NAMES) {
      const policy = { ...JOB_POLICIES[name], ...o.policies?.[name] };
      const dead = deadLetterQueue(name);
      // Dead letters wait for an operator: no retries, kept for the default 14 days.
      await ensure(dead, { ...queueOptions(policy), retryLimit: 0 });
      await ensure(name, { ...queueOptions(policy), policy: policy.exclusive ? 'singleton' : 'standard', deadLetter: dead });
      queues.push(name, dead);
    }
    await boss.getDb().executeSql(
      [
        `grant usage on schema ${schema} to ${o.appRole}`,
        `grant select, insert, update, delete on all tables in schema ${schema} to ${o.appRole}`,
        `grant usage, select, update on all sequences in schema ${schema} to ${o.appRole}`,
        `grant execute on all functions in schema ${schema} to ${o.appRole}`,
        `alter default privileges in schema ${schema} grant select, insert, update, delete on tables to ${o.appRole}`,
        `alter default privileges in schema ${schema} grant usage, select, update on sequences to ${o.appRole}`,
        `alter default privileges in schema ${schema} grant execute on functions to ${o.appRole}`,
      ].join(';\n'),
    );
    if (errors.length > 0) throw errors[0];
    return { queues };
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
}
