import { and, eq } from 'drizzle-orm';
import { submissionKey, submissions, type SubmissionStatus, type Tx } from '@form/db';
import type { SubmissionEvent } from '@form/ports';
import type { Logger } from 'pino';
import { defineJob, type JobDefinition } from './define.ts';

/** What a fan-out consumer is told about a submission: ids and the status only, never an answer (a consumer that needs answers reads them itself, under its own purposes). */
export interface FanoutTarget {
  orgId: string;
  formId: string;
  formVersionId: string;
  submissionId: string;
  status: SubmissionStatus;
  event: SubmissionEvent;
}

/**
 * One effect of a stored response: notifications, webhooks, integrations, workflows, analytics counters. Each arrives
 * with its own work package (WP-1.16, WP-1.18, ...) and is skipped by the handler when the form has not configured it.
 * It runs inside the job's tenant transaction as actor `system`, and may enqueue its own jobs through `tx`.
 */
export type FanoutConsumer = (target: FanoutTarget, ctx: { tx: Tx; log: Logger; signal: { throwIfAborted(): void } }) => Promise<void>;

/**
 * `submission.fanout` (architecture §2.5 step 5, §5.2): the one job a committed response sends, through the submit
 * transaction, so it exists exactly when the response does. The handler loads the submission as `system` inside the
 * org's tenant and hands it to each consumer; there are no consumers yet, so it loads, finds the response and acks.
 *
 * The envelope's resource is the FORM (`resolve_job_org` resolves forms, and the worker already checked that the
 * envelope's org owns it); the submission is looked up under that form, by its id and the partition key the id implies.
 * A submission that is not there (deleted forever since the job was sent, or an id that names nothing in this form and
 * org) is acked and left alone: a retry would find the same nothing.
 */
export function createSubmissionFanout(consumers: readonly FanoutConsumer[] = []): JobDefinition<'submission.fanout'> {
  return defineJob({
    name: 'submission.fanout',
    perms: [],
    async run({ tx, orgId, log, job }) {
      const { resource, data } = job.envelope;
      const [row] = await tx
        .select({ id: submissions.id, formId: submissions.formId, formVersionId: submissions.formVersionId, status: submissions.status })
        .from(submissions)
        .where(and(eq(submissions.formId, resource.id), submissionKey(data.submissionId)))
        .limit(1);
      if (!row) {
        log.info({ submissionId: data.submissionId, formId: resource.id, event: data.event }, 'submission.fanout: no such submission; nothing to fan out');
        return;
      }
      const target: FanoutTarget = { orgId, formId: row.formId, formVersionId: row.formVersionId, submissionId: row.id, status: row.status, event: data.event };
      for (const consumer of consumers) {
        job.signal.throwIfAborted();
        await consumer(target, { tx, log, signal: job.signal });
      }
      log.debug({ submissionId: row.id, event: data.event, consumers: consumers.length }, 'submission.fanout done');
    },
  });
}

/** The registered handler: no consumers until the notification, webhook and integration work packages add theirs. */
export const submissionFanout = createSubmissionFanout();
