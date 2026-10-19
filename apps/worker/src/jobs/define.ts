import type { Db, Tx } from '@form/db';
import type { JobName, JobScopeOf, ReceivedJob } from '@form/ports';
import type { Logger } from 'pino';

interface BaseContext<N extends JobName> {
  job: ReceivedJob<N>;
  log: Logger;
}

/** Inside `withTenant` for the envelope's org (re-derived from the resource), as actor `system` with the job's perms. */
export interface OrgJobContext<N extends JobName> extends BaseContext<N> {
  kind: 'org';
  orgId: string;
  tx: Tx;
}

/** No tenant: the fr_app pool, which sees no tenant rows; org-spanning work goes through definer functions. */
export interface SystemJobContext<N extends JobName> extends BaseContext<N> {
  kind: 'system';
  db: Db;
}

export type JobContext<N extends JobName> =
  JobScopeOf<N> extends 'org' ? OrgJobContext<N> : JobScopeOf<N> extends 'system' ? SystemJobContext<N> : OrgJobContext<N> | SystemJobContext<N>;

export interface JobDefinition<N extends JobName> {
  name: N;
  /** Loaded into `app.perms` for org runs: the least the handler needs. */
  perms: readonly string[];
  /** UTC cron the worker schedules for this queue (system and `any` jobs, which then run without a tenant). */
  cron?: JobScopeOf<N> extends 'org' ? never : string;
  /** Idle polling of this queue, when it must react faster than the worker default. */
  pollIntervalMs?: number;
  run(ctx: JobContext<N>): Promise<void>;
}

export type AnyJobDefinition = { [N in JobName]: JobDefinition<N> }[JobName];

export const defineJob = <N extends JobName>(def: JobDefinition<N>): JobDefinition<N> => def;
