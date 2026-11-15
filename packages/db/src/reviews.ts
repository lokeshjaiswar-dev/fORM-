import { sql } from 'drizzle-orm';
import { ReviewSettingsSchema, type ReviewSettings } from '@form/schema';
import type { Executor } from './client.ts';
import type { ReviewDecision, ReviewReasonCode, ReviewState, ReviewVisibility } from './schema/reviews.ts';
import type { SubmissionStatus } from './schema/submissions.ts';
import { isUuid, pgArray } from './tenant.ts';

/**
 * Typed calls of the section-level review functions (WP-2.33, migration 0024) and the reviewer's scope. The two functions are
 * the only way to write `submission_reviews` and `review_decisions` and to move a response out of `pending_review`: fr_app
 * has SELECT only on the tables, and a trigger stops it changing the status. Run them inside the tenant transaction of the
 * request (`withTenant`), in the same transaction as the audit event the API appends for them.
 */

/** sha256 is 32 bytes. */
const HASH_BYTES = 32;

function assertHash(name: string, hash: Uint8Array): void {
  if (hash.byteLength !== HASH_BYTES) throw new TypeError(`${name} must be a sha256 digest of ${HASH_BYTES} bytes`);
}

function assertUuid(name: string, value: string): void {
  if (!isUuid(value)) throw new TypeError(`${name} must be a uuid`);
}

/** One review unit of a response, as the API composes it from the form's review settings and the response's answers. */
export interface ReviewOpenUnit {
  unitId: string;
  groupId: string;
  /** At least 1. Units of the same order are reviewed in parallel; a higher order waits for the lower ones. */
  order: number;
  required: boolean;
  visibility: ReviewVisibility;
  /** False when every block of the unit was hidden or off the respondent's path: the unit is stored `not_applicable` and never asked. */
  applicable: boolean;
  /** sha256 of the unit's stored answers (32 bytes); a decision must name it. */
  answersHash: Uint8Array;
}

export interface ReviewOpenInput {
  /** The response the submit transaction has just stored with status `pending_review`. */
  submissionId: string;
  receivedAt: Date;
  /** The version the response was validated against: must be the response's own `form_version_id`. */
  formVersionId: string;
  /** One element per review unit of the form (1 to 200). At least one must be required and applicable. */
  units: readonly ReviewOpenUnit[];
  /**
   * The addresses the respondent gave (every email-type answer). Used only to exclude the active members of the org whose
   * verified address is one of them from checking the response; never stored. A member who joins or verifies afterwards is not excluded.
   */
  respondentEmails?: readonly string[] | undefined;
}

export interface ReviewOpened {
  /** Rows written: one per unit. */
  units: number;
  /** How many of them wait for a checker (the applicable ones). */
  pending: number;
  /** How many members were excluded by the email match; for the audit event (a count, never an address). */
  excluded: number;
}

/** The same normalisation as `users.email_norm` (`normaliseEmail` in the API): trimmed, NFC, lower-case. */
const normaliseAddress = (email: string): string => email.trim().normalize('NFC').toLowerCase();

/**
 * Opens the review of a held response (`review_open()`): writes the round-1 row of every unit and excludes the members
 * whose verified address the respondent gave. Call it in the submit transaction, after the response is stored with status
 * `pending_review`, from a respondent, user or system context. It raises (and the transaction must roll back) when the
 * response is not `pending_review`, already has review rows, belongs to another org or version, the units are malformed,
 * or no unit is both required and applicable: in that last case store the response `complete` instead of holding it.
 * A signed-in user's context makes that user the maker of every unit; a respondent's or a job's makes none.
 */
export async function reviewOpen(db: Executor, input: ReviewOpenInput): Promise<ReviewOpened> {
  assertUuid('submissionId', input.submissionId);
  assertUuid('formVersionId', input.formVersionId);
  const units = input.units.map((u) => {
    assertUuid('groupId', u.groupId);
    assertHash('answersHash', u.answersHash);
    return {
      unitId: u.unitId,
      groupId: u.groupId,
      order: u.order,
      required: u.required,
      visibility: u.visibility,
      applicable: u.applicable,
      answersHash: Buffer.from(u.answersHash).toString('hex'),
    };
  });
  const emails = [...new Set((input.respondentEmails ?? []).map(normaliseAddress).filter((e) => e.length > 0))];
  const { rows } = await db.execute<{ unit_count: number; pending_count: number; excluded_count: number }>(
    sql`select unit_count, pending_count, excluded_count from review_open(${input.submissionId}::uuid, ${input.receivedAt.toISOString()}::timestamptz,
      ${input.formVersionId}::uuid, ${JSON.stringify(units)}::jsonb, ${pgArray(emails)}::text[])`,
  );
  const row = rows[0];
  if (!row) throw new Error('review_open returned no row');
  return { units: row.unit_count, pending: row.pending_count, excluded: row.excluded_count };
}

/**
 * What `review_decide()` answers, in the order it decides. Every outcome but `decided` is a refusal that wrote nothing: the
 * API maps `permission_denied`, `not_in_group`, `mfa_required` and `four_eyes_violation` to 403 and `review_closed`,
 * `order_blocked`, `review_stale` and `idempotency_key_reused` to 409, and appends a denied audit event for each on the
 * separate audit connection.
 */
export const REVIEW_DECIDE_OUTCOMES = [
  'permission_denied',
  'not_found',
  'idempotency_key_reused',
  'not_in_group',
  'mfa_required',
  'review_closed',
  'order_blocked',
  'review_stale',
  'four_eyes_violation',
  'decided',
] as const;
export type ReviewDecideOutcome = (typeof REVIEW_DECIDE_OUTCOMES)[number];

export interface ReviewDecideInput {
  submissionId: string;
  receivedAt: Date;
  unitId: string;
  decision: ReviewDecision;
  /** From the fixed catalogue: required for a reject, absent for an approve. */
  reasonCode?: ReviewReasonCode | null | undefined;
  /** sha256 of the unit's answers as the checker saw them (32 bytes); a different current hash makes the decision `review_stale`. */
  answersHash: Uint8Array;
  /** Scoped to the response: a retry with the same key and the same request returns the first result. 1 to 255 characters. */
  idempotencyKey: string;
  /** The id the server made for the decision (a UUIDv7). */
  decisionId: string;
}

export interface ReviewDecideResult {
  outcome: ReviewDecideOutcome;
  /** The decision's id; null unless the outcome is `decided`. */
  decisionId: string | null;
  /** The unit's state after the call (or, for a refusal, as it stands); null while the caller is not yet known to be a checker of the unit. */
  unitState: ReviewState | null;
  /** `complete` or `rejected` when this decision finalised the response, else as it stands. For a replay this is the status now. */
  submissionStatus: SubmissionStatus | null;
  /**
   * True when the outcome is the first result of a retried idempotency key: nothing was written, so the caller must not
   * append the audit event or enqueue the fan-out again.
   */
  replayed: boolean;
}

/**
 * A checker's decision on one unit (`review_decide()`). It checks, in one transaction and as the guarantee behind the API's
 * own earlier checks: the permission `submissions.review`, group membership, two-factor sign-in (when the org requires it),
 * that the unit and the response are still open, the unit order, the answers' hash, and the four-eyes rule. It then writes the decision, moves
 * the unit, bumps its revision, and finalises the response (`complete` when every required applicable unit is approved,
 * `rejected` on a required reject, the rest of the units `closed`). The audit events are the caller's to append.
 */
export async function reviewDecide(db: Executor, input: ReviewDecideInput): Promise<ReviewDecideResult> {
  assertUuid('submissionId', input.submissionId);
  assertUuid('decisionId', input.decisionId);
  assertHash('answersHash', input.answersHash);
  const { rows } = await db.execute<{
    outcome: ReviewDecideOutcome;
    decision_id: string | null;
    unit_state: ReviewState | null;
    submission_status: SubmissionStatus | null;
    replayed: boolean;
  }>(
    sql`select outcome, decision_id, unit_state, submission_status, replayed from review_decide(${input.submissionId}::uuid,
      ${input.receivedAt.toISOString()}::timestamptz, ${input.unitId}, ${input.decision}, ${input.reasonCode ?? null}, ${Buffer.from(input.answersHash)},
      ${input.idempotencyKey}, ${input.decisionId}::uuid)`,
  );
  const row = rows[0];
  if (!row) throw new Error('review_decide returned no row');
  return { outcome: row.outcome, decisionId: row.decision_id, unitState: row.unit_state, submissionStatus: row.submission_status, replayed: row.replayed };
}

/** What a user is, in respect of one form's review: the live settings, and the groups of theirs that are assigned a unit of it. */
export interface ReviewerScope {
  /** The form's review settings, or null when the form was never set up for review. `enabled` can be false while reviews opened earlier are still running. */
  settings: ReviewSettings | null;
  /**
   * The review groups the user is an active member of that the settings assign a unit of this form to, archived ones
   * included (a group that was archived may still have reviews in flight). Empty means the user is not acting as a
   * reviewer on this form; any entry means they are, whatever their role (owners and admins too), and `own_unit`
   * redaction applies to them (decision of the plan).
   * Read from the live settings: a review opened earlier keeps the group it was opened with, which is on its review row.
   */
  groupIds: string[];
}

/**
 * The review scope of `userId` on `formId`, inside a tenant transaction (the org is the context's: both tables are read
 * under RLS, and a form or user of another org reads as no settings and no groups). It never reads response data. A settings
 * row that no longer parses is an error, not "no review": a reader that treated it as unreviewed would show a checker
 * every unit's answers.
 */
export async function reviewerScope(tx: Executor, args: { formId: string; userId: string }): Promise<ReviewerScope> {
  assertUuid('formId', args.formId);
  assertUuid('userId', args.userId);
  const found = await tx.execute<{ enabled: boolean; settings: Record<string, unknown> }>(
    sql`select enabled, settings from form_review_settings where form_id = ${args.formId}::uuid`,
  );
  const row = found.rows[0];
  if (!row) return { settings: null, groupIds: [] };
  // A row made with the defaults (`enabled` false, settings '{}') parses as "no units".
  const parsed = ReviewSettingsSchema.safeParse({ distinctCheckers: false, units: [], ...row.settings, enabled: row.enabled });
  if (!parsed.success) throw new Error(`the review settings of form ${args.formId} are not valid: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const settings = parsed.data;
  // A group id that is not a uuid cannot name a group; leaving it out keeps the cast below from failing on it.
  const assigned = [...new Set(settings.units.map((u) => u.groupId as string).filter(isUuid))];
  if (assigned.length === 0) return { settings, groupIds: [] };
  const groups = await tx.execute<{ group_id: string }>(
    sql`select g.group_id from review_group_members g
        join memberships m on m.org_id = g.org_id and m.user_id = g.user_id
        where g.user_id = ${args.userId}::uuid and g.group_id = any (${pgArray(assigned)}::uuid[]) and m.status = 'active'
        order by g.group_id`,
  );
  return { settings, groupIds: groups.rows.map((r) => r.group_id) };
}
