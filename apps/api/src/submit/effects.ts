import type { Answers, CompiledForm, FormDefinition } from '@form/schema';
import type { Tx } from '@form/db';

/**
 * What the submit transaction has decided when it runs the effects of a stored response. Everything the effects need is
 * here, so adding one (the search document, the fan-out job, the unique-ID counters) is a change to this file and not to
 * the pipeline. Nothing in it is the respondent's word: the answers are the server's evaluation of them, the ids and the
 * moment are the server's, and the org comes from the slug.
 */
export interface EffectsContext {
  orgId: string;
  formId: string;
  formVersionId: string;
  /** The version's number within its form. */
  versionNumber: number;
  submissionId: string;
  /** The moment the server took the answers (the one inside `submissionId`, and `submissions.received_at`). */
  receivedAt: Date;
  /** `complete` today; the held statuses (payment, scan, guardian consent) arrive with their work packages and enqueue nothing. */
  status: 'complete';
  locale: string;
  /** The validated answers as they are stored (plain, until WP-1.11 encrypts the sensitive ones), with file references rewritten from the upload rows. */
  answers: Answers;
  /** The version the answers were checked against. */
  definition: FormDefinition;
  compiled: CompiledForm;
}

/**
 * The hook for what a stored response sets in motion inside its own transaction: the search document, the single
 * `submission.fanout` job (the transactional outbox, so a rolled-back submission enqueues nothing), the gap-free
 * unique-ID counters. It runs after the INSERT of the submission and before the guarded counter update that can still
 * roll everything back, so whatever it writes is undone with the rest by a `LIMIT_REACHED`. A no-op until WP-1.12's
 * effects work fills it in.
 */
export async function recordEffects(_tx: Tx, _ctx: EffectsContext): Promise<void> {
  // Deliberately empty.
}
