import { defineMessages, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import { ApiProblem } from '@/auth/client';
import { describeFailure } from '@/components/responses/errors';
import { REASON_CODES, isIndeterminate, type ReasonCode } from '@/persistence/reviewsApi';

/*
 * The words of the checker's screens (WP-2.33): where a unit stands, why a reject was made, and what to tell the member when
 * a decision was refused. The API's own `detail` is written for logs, so none of it is shown: each refusal the API gives a
 * code for has a sentence here, in plain language.
 */

const M = defineMessages('builder', {
  'review_state.pending': 'Waiting for a checker',
  'review_state.approved': 'Approved',
  'review_state.rejected': 'Rejected',
  'review_state.not_applicable': 'Not needed',
  'review_state.closed': 'Closed',
  'review_reason.incomplete': 'Incomplete',
  'review_reason.incorrect': 'Incorrect',
  'review_reason.missing_document': 'Missing document',
  'review_reason.duplicate': 'Duplicate',
  'review_reason.other': 'Other',
  'review_error.four_eyes': 'You cannot review a unit you filled in or changed. Another checker has to decide it.',
  'review_error.not_in_group': 'You are not one of the checkers for this unit.',
  'review_error.mfa': 'Your organisation asks checkers to sign in with two-factor authentication. Turn it on under Security, sign in again, then try again.',
  'review_error.stale': 'The answers changed after you read them, so nothing was saved. They are loaded again below: read them, then decide.',
  'review_error.closed': 'This unit was already decided, so nothing was saved. Its latest state is shown below.',
  'review_error.order_blocked': 'An earlier step has to be approved first, so nothing was saved.',
  'review_error.unreachable': 'The server could not be reached. Press the button again: a decision that did reach the server is not recorded twice.',
  'review_error.generic': 'The decision could not be saved. Try again.',
});

const STATES: Record<string, MessageId> = {
  pending: M['review_state.pending'],
  approved: M['review_state.approved'],
  rejected: M['review_state.rejected'],
  not_applicable: M['review_state.not_applicable'],
  closed: M['review_state.closed'],
};

/** The badge tone of a unit's state; a state this build does not know is neutral. */
export const STATE_TONE: Record<string, 'success' | 'danger' | 'warning' | 'secondary'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  not_applicable: 'secondary',
  closed: 'secondary',
};

/** Where a unit stands, in words; a state this build does not know is shown as the API named it. */
export function unitStateLabel(state: string): string {
  const id = STATES[state];
  return id ? t(id) : state;
}

const REASONS: Record<ReasonCode, MessageId> = {
  incomplete: M['review_reason.incomplete'],
  incorrect: M['review_reason.incorrect'],
  missing_document: M['review_reason.missing_document'],
  duplicate: M['review_reason.duplicate'],
  other: M['review_reason.other'],
};

/** Why a unit was rejected, in words; a reason this build does not know is shown as the API named it. */
export function reasonLabel(code: string): string {
  return code in REASONS ? t(REASONS[code as ReasonCode]) : code;
}

/** The reasons a checker can pick, in the catalogue's order, labelled in the builder's language. */
export const reasonOptions = (): Array<{ value: ReasonCode; label: string }> => REASON_CODES.map((value) => ({ value, label: reasonLabel(value) }));

/** The text of the four-eyes refusal, which the panel also gives a checker who is in a unit's group but is barred from deciding it. */
export const fourEyesText = (): string => t(M['review_error.four_eyes']);

/** What a failed decision tells the member, and whether the unit is shut to them for good (they cannot decide it however often they press). */
export interface DecisionFailure {
  text: string;
  /** The API's code of the refusal, when it gave one. */
  code: string | null;
  /** The member is barred from this unit: the buttons are taken away instead of offered again. */
  barred: boolean;
  /** The server may have stored the decision: the member presses the same button again, with the same key. */
  retry: boolean;
  /** What the member read is out of date (stale answers, a unit already decided, an earlier step open): the panel reads the response again. */
  reload: boolean;
}

/** The sentence and the follow-up for a decision that did not go through. The server's own wording is never shown. */
export function decisionFailure(err: unknown): DecisionFailure {
  const plain = (text: string, code: string | null, rest: Partial<DecisionFailure> = {}): DecisionFailure => ({ text, code, barred: false, retry: false, reload: false, ...rest });
  if (isIndeterminate(err)) return plain(t(M['review_error.unreachable']), null, { retry: true });
  if (err instanceof ApiProblem) {
    switch (err.code) {
      case 'FOUR_EYES_VIOLATION':
        return plain(t(M['review_error.four_eyes']), err.code, { barred: true });
      case 'NOT_IN_REVIEW_GROUP':
        return plain(t(M['review_error.not_in_group']), err.code, { barred: true });
      case 'MFA_REQUIRED':
        return plain(t(M['review_error.mfa']), err.code);
      case 'REVIEW_STALE':
        return plain(t(M['review_error.stale']), err.code, { reload: true });
      case 'REVIEW_CLOSED':
        return plain(t(M['review_error.closed']), err.code, { reload: true });
      case 'REVIEW_ORDER_BLOCKED':
        return plain(t(M['review_error.order_blocked']), err.code, { reload: true });
      default:
        return plain(describeFailure(err, M['review_error.generic']), err.code);
    }
  }
  return plain(t(M['review_error.generic']), null);
}
