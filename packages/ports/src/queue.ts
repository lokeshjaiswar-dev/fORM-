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
  'audit.chain': NoData;
  'audit.checkpoint': NoData;
  'audit.verify': NoData;
  /** `YYYY-MM` of the month to export and detach. */
  'audit.archive': { month: string };
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
  'system.heartbeat': { scope: 'system' },
} as const satisfies { readonly [N in JobName]: { readonly scope: JobScope } };

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

export interface SendOptions {
  /** At most one queued job per key; a duplicate send returns null. */
  singletonKey?: string;
  startAfter?: IsoInstant;
}

export interface ReceivedJob<N extends JobName> {
  id: string;
  name: N;
  /** 1 on the first try. */
  attempt: number;
  /** Signature already verified and the org re-derived from the resource. */
  envelope: JobEnvelope<N>;
}

export type JobHandler<N extends JobName> = (job: ReceivedJob<N>) => Promise<void>;

export interface WorkOptions {
  concurrency?: number;
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
