import type { Db, Tx } from '@form/db';
import type { JobName, JobScopeOf, ReceivedJob } from '@form/ports';
import type { Logger } from 'pino';

interface BaseContext<N extends JobName> {
  job: ReceivedJob<N>;
  log: Logger;
}

/**
 * Inside `withTenant` for the envelope's org (re-derived from the resource), as actor `system` with the job's perms.
 * The whole attempt is one transaction (`transaction: 'job'`, the default).
 */
export interface OrgJobContext<N extends JobName> extends BaseContext<N> {
  kind: 'org';
  orgId: string;
  tx: Tx;
}

/** The tenant transaction of a `transaction: 'manual'` job, one call at a time (see `ManualOrgJobContext.inTenant`). */
export type InTenant = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/**
 * An org job that opens its own short transactions (`transaction: 'manual'`). There is no `tx` here on purpose: the job
 * calls `inTenant(fn)` for each unit of database work and does its slow outside call (SMTP, an HTTP delivery, an object
 * store upload) between two calls, with no connection held. Every `inTenant` is `withTenant` with the identity a `'job'`
 * run has: the envelope's org, actor `system`, the definition's `perms`, request id `job:<id>`, so RLS and the audit
 * trail look the same either way.
 */
export interface ManualOrgJobContext<N extends JobName> extends BaseContext<N> {
  kind: 'org';
  orgId: string;
  /**
   * Runs `fn` in one tenant transaction and commits when it returns. Like a `'job'` run, a transaction whose attempt was
   * interrupted (shutdown, expiry) rolls back and throws, and a call after the interruption does not start. Do not nest
   * calls: the inner one takes a second connection and can starve the pool.
   */
  inTenant: InTenant;
  /** Never set: a manual job has no transaction of its own. */
  tx?: undefined;
}

/** No tenant: the fr_app pool, which sees no tenant rows; org-spanning work goes through definer functions. */
export interface SystemJobContext<N extends JobName> extends BaseContext<N> {
  kind: 'system';
  db: Db;
}

type ContextFor<N extends JobName, Org> = JobScopeOf<N> extends 'org' ? Org : JobScopeOf<N> extends 'system' ? SystemJobContext<N> : Org | SystemJobContext<N>;

export type JobContext<N extends JobName> = ContextFor<N, OrgJobContext<N>>;
export type ManualJobContext<N extends JobName> = ContextFor<N, ManualOrgJobContext<N>>;

interface JobDefinitionBase<N extends JobName> {
  name: N;
  /** Loaded into `app.perms` for org runs: the least the handler needs. */
  perms: readonly string[];
  /** UTC cron the worker schedules for this queue (system and `any` jobs, which then run without a tenant). */
  cron?: JobScopeOf<N> extends 'org' ? never : string;
  /** Idle polling of this queue, when it must react faster than the worker default. */
  pollIntervalMs?: number;
}

/** One transaction for the whole attempt: the default, right for work that is only database work. */
export interface TransactionJobDefinition<N extends JobName> extends JobDefinitionBase<N> {
  transaction?: 'job';
  run(ctx: JobContext<N>): Promise<void>;
}

/**
 * The job opens its own transactions with `ctx.inTenant`. For jobs that call out to something slow (an SMTP server, a
 * customer's webhook, the object store): a 30 s HTTP call inside the one long transaction would pin a pool connection for
 * its whole length. The job owns the ordering: record intent in one `inTenant`, call out, record the result in another,
 * and make each step safe to repeat, because an attempt can be retried between two of them.
 */
export interface ManualJobDefinition<N extends JobName> extends JobDefinitionBase<N> {
  transaction: 'manual';
  run(ctx: ManualJobContext<N>): Promise<void>;
}

export type JobDefinition<N extends JobName> = TransactionJobDefinition<N> | ManualJobDefinition<N>;

export type AnyJobDefinition = { [N in JobName]: JobDefinition<N> }[JobName];

export function defineJob<N extends JobName>(def: ManualJobDefinition<N>): ManualJobDefinition<N>;
export function defineJob<N extends JobName>(def: TransactionJobDefinition<N>): TransactionJobDefinition<N>;
export function defineJob(def: AnyJobDefinition): AnyJobDefinition {
  return def;
}
