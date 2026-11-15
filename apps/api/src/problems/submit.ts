import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of a respondent's submit: the refusals of `POST /v1/p/:slug/submissions` (WP-1.12). Spread into
 * `PROBLEMS` by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 *
 * Three more refusals of the same route use codes that already exist elsewhere: `PASSWORD_REQUIRED` (a protected form
 * and no valid access token), `VALIDATION_FAILED` (a request that is not shaped like a submission, such as a missing
 * `Idempotency-Key`) and `NOT_FOUND` (a form that is not published).
 *
 * `FORM_CLOSED`, `LIMIT_REACHED` and `VERSION_SUPERSEDED` are 409 and not 403 on purpose: the error handler audits every
 * 403 as a denied action, and a closed or full form is refused by every respondent that arrives, so each of them would
 * write an audit row. They are not a permission problem either: the same request would have been taken a moment earlier.
 */
export const SUBMIT_PROBLEMS = {
  /** The answers broke the form's rules (the body's `errors` name each field), or named a file that is not theirs to name. */
  SUBMISSION_INVALID: { status: 422, title: 'Some answers are not valid' },
  /** The form is switched off, past its close date, before its open date or outside its weekly hours (ACC-01..03, ACC-06). */
  FORM_CLOSED: { status: 409, title: 'This form is not taking responses' },
  /** The submission limit was reached, by the status check or by the counter's guarded update at the end of the transaction (ACC-04). */
  LIMIT_REACHED: { status: 409, title: 'This form has reached its limit of responses' },
  /** The page was built from a version that is neither live nor still inside `accept_previous_versions_hours` (F-34). */
  VERSION_SUPERSEDED: { status: 409, title: 'This form was updated while you were filling it' },
  /** The `Idempotency-Key` was already used for different answers: a retry sends the same body, so this is a mistake. */
  IDEMPOTENCY_KEY_REUSED: { status: 422, title: 'That Idempotency-Key was used for a different submission' },
} as const satisfies Record<string, ProblemSpec>;
