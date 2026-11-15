import { sql } from 'drizzle-orm';
import { audit, auditActor, reviewOpen, txExecutor, type ReviewDecideResult, type ReviewOpened, type ReviewOpenUnit, type Tx } from '@form/db';
import { applicableUnits, reviewUnitAnswersHash } from '@form/logic';
import { toIsoInstant, type Queue } from '@form/ports';
import { ReviewSettingsSchema, type Answers, type CompiledForm, type EvalState, type ReviewSettings, type ReviewUnitId } from '@form/schema';

/*
 * Holding a response for review (WP-2.33), the two ends of its life that the submit and decide transactions share:
 *
 *   planReview     at submit: is this response held, and for which units. Pure but for one read of the form's settings.
 *   openReview     at submit, right after the response is stored `pending_review`: `review_open()` writes the unit rows
 *                  and the API appends `review.opened` in the same transaction (the SQL definers append nothing).
 *   finaliseOnDecision
 *                  at decide: the response that a decision made `complete` is released to its side effects; one that was
 *                  rejected is not (there is no rejected event in @form/ports in slice 1).
 *
 * Nothing here trusts the respondent: the units come from the form's stored settings and the version's compiled form,
 * which units apply from the server's own evaluation of the answers, and the hash of each from the answers as stored.
 */

/** What `review_open()` is given for one stored response, composed here from the form's settings and the answers. */
export interface ReviewPlan {
  /** One element per assigned review unit that the version holds (1 to 200); at least one is required and applicable. */
  units: ReviewOpenUnit[];
  /** Every address the respondent gave (every email-type answer, and a guardian's), as typed. The database matches them to verified members and stores none. */
  respondentEmails: string[];
}

export interface PlanInput {
  /** The version the answers were validated against: its units and their blocks. */
  compiled: CompiledForm;
  /** The answers as they will be stored (unique IDs numbered): each unit's hash is taken from these. */
  answers: Answers;
  /** The server's evaluation of the answers: which blocks were shown to the respondent. */
  evalState: Pick<EvalState, 'visible'>;
}

/** `review_open()` takes at most this many addresses; a submission with more is refused before it is stored (see `emailsOf`). */
const MAX_RESPONDENT_EMAILS = 100;

/** Whether the version has any review unit at all: a form that never had one skips the read of its settings. */
export const hasReviewUnits = (compiled: Pick<CompiledForm, 'reviewUnits'>): boolean => Object.keys(compiled.reviewUnits ?? {}).length > 0;

/**
 * The form's review settings, or null when it is not reviewed: the version has no unit, the form has no settings row, or
 * review is switched off. Read in the submit transaction through the respondent's context, which the table allows.
 * A row that does not parse is an error and not "not reviewed": a form that silently stopped being reviewed would
 * release every response unchecked.
 */
export async function readReviewSettings(tx: Tx, formId: string, compiled: Pick<CompiledForm, 'reviewUnits'>): Promise<ReviewSettings | null> {
  if (!hasReviewUnits(compiled)) return null;
  const { rows } = await tx.execute<{ enabled: boolean; settings: Record<string, unknown> }>(
    sql`select enabled, settings from form_review_settings where form_id = ${formId}::uuid`,
  );
  const row = rows[0];
  if (!row?.enabled) return null;
  // The column wins over the copy of the flag inside the document, as for the settings routes.
  const parsed = ReviewSettingsSchema.safeParse({ distinctCheckers: false, units: [], ...row.settings, enabled: true });
  if (!parsed.success) throw new Error(`the review settings of form ${formId} are not valid: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  return parsed.data;
}

/**
 * The addresses in the answers: every email-type answer (also inside a repeating group's rows) and the guardian address
 * of a consent. Conservative on purpose (decision of the plan): a member whose verified address is any of them cannot
 * check the response, whichever field it is in. More than `review_open()` takes is an error, not a silent cut, because
 * the addresses left out would not be excluded.
 */
export function emailsOf(answers: Answers): string[] {
  const found = new Set<string>();
  const take = (address: unknown): void => {
    if (typeof address === 'string' && address.trim() !== '') found.add(address);
  };
  const walk = (answer: unknown, depth: number): void => {
    if (typeof answer !== 'object' || answer === null || depth > 3) return;
    const { type, value } = answer as { type?: unknown; value?: unknown };
    if (typeof value !== 'object' || value === null) return;
    if (type === 'email') take((value as { address?: unknown }).address);
    else if (type === 'consent') take((value as { guardian?: { email?: unknown } }).guardian?.email);
    else if (type === 'repeating_group') {
      const rows = (value as { rows?: unknown }).rows;
      if (Array.isArray(rows)) for (const row of rows) for (const inner of Object.values((row as { values?: Record<string, unknown> } | null)?.values ?? {})) walk(inner, depth + 1);
    }
  };
  for (const answer of Object.values(answers)) walk(answer, 0);
  if (found.size > MAX_RESPONDENT_EMAILS) throw new Error(`a response with more than ${MAX_RESPONDENT_EMAILS} email addresses cannot be held for review`);
  return [...found];
}

/**
 * The units a response is held for, from settings already read; null when it is not held. Held means at least one unit
 * is both required and applicable (a required unit whose blocks were all hidden, or off the respondent's path, is
 * `not_applicable` and asks for nothing: with only such units the response is `complete`, as it would be without review).
 *
 * Only an assignment of a unit that this version holds counts: the settings are live and name units by id, the version
 * is the one the answers were checked against, and a unit the version lacks has no blocks to review or to hash. Every
 * unit that counts is written, applicable or not, so the reviewers' queue and the respondent's receipt can say so.
 */
export function planReviewFrom(settings: ReviewSettings | null, input: PlanInput): ReviewPlan | null {
  if (settings === null || !settings.enabled) return null;
  const { compiled, answers } = input;
  const applicability = new Map<ReviewUnitId, string>(applicableUnits(compiled, input.evalState).map((u) => [u.unitId, u.state]));
  const units: ReviewOpenUnit[] = [];
  for (const assignment of settings.units) {
    const hash = reviewUnitAnswersHash(compiled, assignment.unitId, answers);
    if (hash === null) continue;
    units.push({
      unitId: assignment.unitId,
      groupId: assignment.groupId,
      order: assignment.order,
      required: assignment.required,
      visibility: assignment.visibility,
      applicable: applicability.get(assignment.unitId) === 'applicable',
      answersHash: Buffer.from(hash, 'hex'),
    });
  }
  if (!units.some((u) => u.required && u.applicable)) return null;
  return { units, respondentEmails: emailsOf(answers) };
}

/** `planReviewFrom` with the settings read in the transaction (`readReviewSettings`). */
export async function planReview(tx: Tx, input: PlanInput & { formId: string }): Promise<ReviewPlan | null> {
  return planReviewFrom(await readReviewSettings(tx, input.formId, input.compiled), input);
}

export interface OpenedResponse {
  orgId: string;
  formId: string;
  /** The version the response was validated against. */
  formVersionId: string;
  submissionId: string;
  receivedAt: Date;
  requestId: string;
  plan: ReviewPlan;
}

/**
 * Writes the round-1 rows of a response the submit transaction has just inserted with status `pending_review`
 * (`review_open()`, which also excludes the members whose verified address the respondent gave), and appends
 * `review.opened` in the same transaction. A respondent's context makes no maker of the units (there is no signed-in
 * fill path yet), so the four-eyes rule rests on the address match, `distinctCheckers` and the last editor.
 * The record holds counts and the ids of the response, never an answer or an address.
 */
export async function openReview(tx: Tx, held: OpenedResponse): Promise<ReviewOpened> {
  const opened = await reviewOpen(tx, {
    submissionId: held.submissionId,
    receivedAt: held.receivedAt,
    formVersionId: held.formVersionId,
    units: held.plan.units,
    respondentEmails: held.plan.respondentEmails,
  });
  await audit.append(tx, held.orgId, {
    ...auditActor({ actor: 'respondent', requestId: held.requestId }),
    action: 'review.opened',
    resourceType: 'submission',
    resourceId: held.submissionId,
    formId: held.formId,
    outcome: 'success',
    metadata: { units: opened.units, pending: opened.pending, excluded: opened.excluded },
  });
  return opened;
}

/** What the decide route knows once `reviewDecide()` has answered: where the response is, and what the function said. */
export interface DecisionOutcome extends Pick<ReviewDecideResult, 'outcome' | 'submissionStatus' | 'replayed'> {
  orgId: string;
  formId: string;
  submissionId: string;
  receivedAt: Date;
}

/**
 * Releases a response to its side effects when a decision finalised it as `complete`: one `submission.fanout` job with the
 * event `released`, sent through the decision's own transaction, so the job exists if and only if the decision does
 * (the transactional outbox of architecture §2.5, as for `recordEffects`). The worker maps `released` to what an outside
 * system sees as a new response (notifications `submitted`, webhooks `submission.created`).
 *
 * Nothing is sent for a refusal, for a decision that left the response held (other units are still open), for a
 * `rejected` response (slice 1 has no event for it), or for a replayed decision: its first call sent the job already.
 * Returns whether a job was sent. Without a queue nothing is sent, which only tests do (`main.ts` always passes one).
 */
export async function finaliseOnDecision(tx: Tx, queue: Queue | undefined, result: DecisionOutcome): Promise<boolean> {
  if (result.outcome !== 'decided' || result.replayed || result.submissionStatus !== 'complete' || !queue) return false;
  const jobId = await queue.send(
    'submission.fanout',
    {
      orgId: result.orgId,
      resource: { type: 'form', id: result.formId },
      data: { submissionId: result.submissionId, receivedAt: toIsoInstant(result.receivedAt), event: 'released' },
    },
    { tx: txExecutor(tx) },
  );
  // A standard queue gives every send an id; none means the job was not stored, and a released response whose fan-out
  // never ran would notify no one: fail the decision's transaction instead.
  if (jobId === null) throw new Error('submission.fanout was not enqueued');
  return true;
}
