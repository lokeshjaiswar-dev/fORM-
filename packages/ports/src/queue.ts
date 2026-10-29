import type { IsoInstant } from './common.ts';
import type { SubmissionKey } from './search.ts';

/** A field encrypted with the secrets DEK (magic links, OTP codes, invite tokens); every part base64url. */
export interface SealedSecret {
  v: 1;
  kid: string;
  iv: string;
  ct: string;
}

/** Jobs whose data is empty: cron ticks and org-spanning sweeps that call `orgs_due_for(job)`. */
export type NoData = Record<string, never>;

export type SubmissionEvent = 'created' | 'updated' | 'released';
export type WebhookEvent = 'submission.created' | 'submission.updated' | 'submission.deleted' | 'payment.succeeded' | 'consent.withdrawn';

/**
 * Payload of every queue (architecture §5.2). Payloads carry ids only; a secret travels as a SealedSecret.
 * Adding a queue means adding it here and to JOBS.
 */
export interface JobData {
  'submission.fanout': SubmissionKey & { event: SubmissionEvent };
  'notification.dispatch': SubmissionKey & { notificationId: string };
  'email.send': { emailMessageId: string; secret?: SealedSecret };
  'email.scheduled': { scheduledEmailId: string };
  'webhook.fanout': SubmissionKey & { formId: string; event: WebhookEvent };
  'webhook.deliver': { deliveryId: string };
  'integration.fanout': SubmissionKey & { formId: string; event: WebhookEvent };
  'integration.run': { integrationRunId: string };
  'consent.withdrawn': SubmissionKey & { consentRecordId: string };
  'guardian.expire': NoData;
  'workflow.step': { workflowRunId: string; stepId: string };
  'pdf.render': { pdfRenderId: string };
  'export.build': { exportId: string };
  'file.inspect': { fileId: string };
  'retention.sweep': NoData;
  'signals.ttl': NoData;
  'statutory.purge': NoData;
  /** Also the upload GC of architecture §4.6 (unattached files after 24 h); there is no separate `uploads.gc` queue. */
  'drafts.expire': NoData;
  'dsr.execute': { dsrRequestId: string; action: 'search' | 'export' | 'correct' | 'erase'; dryRun: boolean };
  'dsr.overdue': NoData;
  'inactivity.notify': NoData;
  'inactivity.erase': NoData;
  'org.delete': { deletionRequestId: string };
  'analytics.rollup': NoData;
  'partitions.maintain': NoData;
  /** Resource `{ type: 'audit_chain', id: orgKey }`; the zero key (orgId) is the platform chain. */
  'audit.chain': NoData;
  'audit.checkpoint': NoData;
  'audit.verify': NoData;
  /** `YYYY-MM` of the month to export and detach; the cron run takes the newest month outside the 13-month window. */
  'audit.archive': { month?: string };
  'kms.rotate': NoData;
  'payment.reconcile': { paymentId?: string };
  'billing.meter': NoData;
  'templates.seed': NoData;
  'templates.thumbnail': { templateVersionId: string };
  'templates.update_notify': { templateVersionId: string };
  'templates.export': { exportId: string };
  'templates.import': { importId: string };
  'templates.stats': NoData;
  'search.reindex': { formId: string; reason: 'sensitivity_change' | 'bulk_import' };
  'geoip.refresh': NoData;
  /** Liveness probe: with an org it makes one round trip inside that tenant, without one it checks the database. */
  'system.heartbeat': NoData;
}

export type JobName = keyof JobData;

/**
 * `org`: runs inside one tenant; the envelope names the org and the handler re-derives it from the resource.
 * `system`: no tenant (cron, org-spanning sweeps). `any`: either, e.g. auth emails sent before an org exists.
 */
export type JobScope = 'org' | 'system' | 'any';

export const JOBS = {
  'submission.fanout': { scope: 'org' },
  'notification.dispatch': { scope: 'org' },
  'email.send': { scope: 'any' },
  'email.scheduled': { scope: 'org' },
  'webhook.fanout': { scope: 'org' },
  'webhook.deliver': { scope: 'org' },
  'integration.fanout': { scope: 'org' },
  'integration.run': { scope: 'org' },
  'consent.withdrawn': { scope: 'org' },
  'guardian.expire': { scope: 'system' },
  'workflow.step': { scope: 'org' },
  'pdf.render': { scope: 'org' },
  'export.build': { scope: 'org' },
  'file.inspect': { scope: 'org' },
  'retention.sweep': { scope: 'system' },
  'signals.ttl': { scope: 'system' },
  'statutory.purge': { scope: 'system' },
  'drafts.expire': { scope: 'system' },
  'dsr.execute': { scope: 'org' },
  'dsr.overdue': { scope: 'system' },
  'inactivity.notify': { scope: 'system' },
  'inactivity.erase': { scope: 'system' },
  'org.delete': { scope: 'org' },
  'analytics.rollup': { scope: 'system' },
  'partitions.maintain': { scope: 'system' },
  'audit.chain': { scope: 'org' },
  'audit.checkpoint': { scope: 'system' },
  'audit.verify': { scope: 'system' },
  'audit.archive': { scope: 'system' },
  'kms.rotate': { scope: 'system' },
  'payment.reconcile': { scope: 'any' },
  'billing.meter': { scope: 'system' },
  'templates.seed': { scope: 'system' },
  'templates.thumbnail': { scope: 'any' },
  'templates.update_notify': { scope: 'any' },
  'templates.export': { scope: 'org' },
  'templates.import': { scope: 'any' },
  'templates.stats': { scope: 'system' },
  'search.reindex': { scope: 'org' },
  'geoip.refresh': { scope: 'system' },
  'system.heartbeat': { scope: 'any' },
} as const satisfies { readonly [N in JobName]: { readonly scope: JobScope } };

/**
 * Retry, expiry and exclusivity of a queue (architecture §5.1, §5.2). Every queue also has a dead-letter queue
 * that receives a job once its retries are spent, and every rejected (forged) envelope.
 */
export interface JobPolicy {
  /** Retries after the first attempt. */
  retryLimit: number;
  retryDelaySeconds: number;
  /** Doubles the delay per retry (with jitter) up to `retryDelayMaxSeconds`. */
  retryBackoff: boolean;
  retryDelayMaxSeconds: number;
  /** An attempt still running after this long is failed, and retried while retries remain. */
  expireInSeconds: number;
  /** At most one job of the queue (per singleton key) is active at a time: cron sweeps, seeding. */
  exclusive: boolean;
  /**
   * At most one queued job per singleton key; a send while one waits is a no-op (pg-boss `short`, or `stately`
   * with `exclusive`). The audit chain dispatcher sends one per org key on every tick and relies on this.
   */
  coalesceQueued: boolean;
  /** Handlers per worker process. */
  concurrency: number;
}

export const DEFAULT_JOB_POLICY: JobPolicy = {
  retryLimit: 2,
  retryDelaySeconds: 30,
  retryBackoff: true,
  retryDelayMaxSeconds: 3600,
  expireInSeconds: 900,
  exclusive: false,
  coalesceQueued: false,
  concurrency: 1,
};

const MINUTE = 60;
const HOUR = 3600;
const LIKE_WEBHOOKS: Partial<JobPolicy> = { retryLimit: 3, retryDelaySeconds: MINUTE, retryDelayMaxSeconds: 24 * HOUR, concurrency: 4 };
const CRON: Partial<JobPolicy> = { exclusive: true };

/** The §5.2 table; queues it lists without a retry column keep the default (a crash or shutdown still retries). */
const POLICY_OVERRIDES: { readonly [N in JobName]?: Partial<JobPolicy> } = {
  'submission.fanout': { retryLimit: 5, retryDelaySeconds: 10, concurrency: 4 },
  'notification.dispatch': { retryLimit: 5, retryDelaySeconds: 30, retryDelayMaxSeconds: HOUR, concurrency: 4 },
  'email.send': { retryLimit: 8, retryDelaySeconds: MINUTE, retryDelayMaxSeconds: 6 * HOUR, concurrency: 8 },
  'webhook.fanout': LIKE_WEBHOOKS,
  'webhook.deliver': LIKE_WEBHOOKS,
  'integration.fanout': LIKE_WEBHOOKS,
  'integration.run': LIKE_WEBHOOKS,
  'consent.withdrawn': { retryLimit: 5 },
  'guardian.expire': CRON,
  'workflow.step': { retryLimit: 5 },
  'pdf.render': { retryLimit: 3 },
  'export.build': { retryLimit: 2, expireInSeconds: HOUR },
  'file.inspect': { retryLimit: 3, concurrency: 2 },
  'retention.sweep': { ...CRON, expireInSeconds: HOUR },
  'signals.ttl': CRON,
  'statutory.purge': CRON,
  'drafts.expire': CRON,
  'dsr.execute': { retryLimit: 3, expireInSeconds: HOUR },
  'dsr.overdue': CRON,
  'inactivity.notify': CRON,
  'inactivity.erase': CRON,
  /** Manual: an operator re-runs it after reading the failure. */
  'org.delete': { retryLimit: 0, expireInSeconds: 4 * HOUR, exclusive: true },
  'analytics.rollup': CRON,
  'partitions.maintain': CRON,
  // One chainer per org holds the head (skip-locked), so jobs of different orgs run side by side.
  'audit.chain': { coalesceQueued: true, retryDelaySeconds: 5, retryDelayMaxSeconds: MINUTE, expireInSeconds: 5 * MINUTE, concurrency: 4 },
  'audit.checkpoint': CRON,
  'audit.verify': { ...CRON, expireInSeconds: 4 * HOUR },
  // The detach gives up after a 1 s lock_timeout (BL-197) rather than stall the chainers, so it gets more tries.
  'audit.archive': { ...CRON, retryLimit: 6, retryDelaySeconds: 2 * MINUTE, retryDelayMaxSeconds: HOUR, expireInSeconds: 4 * HOUR },
  'kms.rotate': CRON,
  'payment.reconcile': { retryLimit: 10, retryDelaySeconds: MINUTE, retryDelayMaxSeconds: HOUR },
  'billing.meter': CRON,
  'templates.seed': { exclusive: true, retryDelaySeconds: 10 },
  'templates.stats': CRON,
  'search.reindex': { retryLimit: 3, expireInSeconds: HOUR },
  'geoip.refresh': CRON,
  'system.heartbeat': { retryLimit: 1, retryDelaySeconds: 5, retryBackoff: false, expireInSeconds: MINUTE },
};

export const JOB_POLICIES = Object.fromEntries(
  (Object.keys(JOBS) as JobName[]).map((name) => [name, { ...DEFAULT_JOB_POLICY, ...POLICY_OVERRIDES[name] }]),
) as { readonly [N in JobName]: JobPolicy };

export type JobScopeOf<N extends JobName> = (typeof JOBS)[N]['scope'];
export type SystemJobName = { [N in JobName]: JobScopeOf<N> extends 'org' ? never : N }[JobName];

type OrgIdFor<S extends JobScope> = S extends 'org' ? string : S extends 'system' ? null : string | null;

export type JobResourceType =
  | 'org'
  | 'submission'
  | 'email_message'
  | 'scheduled_email'
  | 'webhook_delivery'
  | 'integration_run'
  | 'consent_record'
  | 'workflow_run'
  | 'pdf_render'
  | 'export'
  | 'file'
  | 'dsr_request'
  | 'payment'
  | 'template_version'
  | 'template_import'
  | 'form'
  | 'audit_chain'
  | 'system';

export interface JobResource {
  type: JobResourceType;
  id: string;
}

/** What a producer enqueues; the queue signs it into a JobEnvelope. */
export interface JobRequest<N extends JobName> {
  orgId: OrgIdFor<JobScopeOf<N>>;
  resource: JobResource;
  data: JobData[N];
}

/** ADR-0016: `sig` is an HMAC over the other fields with a worker-held key; handlers verify it first. */
export interface JobEnvelope<N extends JobName> extends JobRequest<N> {
  v: 1;
  sig: string;
}

/**
 * Runs one statement inside the caller's open transaction. Passed as `SendOptions.tx`, it makes the enqueue
 * commit or roll back with the business change (the transactional outbox); `@form/db` adapts a Drizzle tx.
 */
export interface SqlExecutor {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface SendOptions {
  /**
   * On a queue that coalesces (`coalesceQueued`) at most one job per key waits and a duplicate send returns null; on an
   * `exclusive` queue at most one job per key runs at a time. On any other queue a key is PortError('unsupported'), so
   * a de-duplication the queue cannot give is never silently dropped (queue contract).
   */
  singletonKey?: string;
  startAfter?: IsoInstant;
  /** Enqueue inside this transaction instead of on a pooled connection of the queue. */
  tx?: SqlExecutor;
}

/** Aborted when the worker shuts down or the attempt expires; the attempt is then retried. An `AbortSignal` qualifies. */
export interface JobSignal {
  readonly aborted: boolean;
  throwIfAborted(): void;
}

export interface ReceivedJob<N extends JobName> {
  id: string;
  name: N;
  /** 1 on the first try. */
  attempt: number;
  /** Signature already verified and the org re-derived from the resource. */
  envelope: JobEnvelope<N>;
  signal: JobSignal;
}

export type JobHandler<N extends JobName> = (job: ReceivedJob<N>) => Promise<void>;

export interface WorkOptions {
  /** Defaults to the queue's `JOB_POLICIES` concurrency. */
  concurrency?: number;
  /** How often an idle handler polls this queue; defaults to the queue adapter's interval (at least 500 ms). */
  pollIntervalMs?: number;
}

export interface Worker {
  stop(): Promise<void>;
}

/** pg-boss in every edition (architecture §5). Enqueue inside the business transaction (outbox). */
export interface Queue {
  send<N extends JobName>(name: N, job: JobRequest<N>, o?: SendOptions): Promise<string | null>;
  work<N extends JobName>(name: N, handler: JobHandler<N>, o?: WorkOptions): Promise<Worker>;
  /** Cron in UTC, single node per schedule. */
  schedule<N extends SystemJobName>(name: N, cron: string, job: JobRequest<N>): Promise<void>;
  unschedule(name: SystemJobName): Promise<void>;
}
