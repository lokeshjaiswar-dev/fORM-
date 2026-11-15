import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the approvals domain: review groups, review settings, the review queue and decisions (WP-2.33). Spread
 * into `PROBLEMS` by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 *
 * The setup task wrote the first four codes; the review queue task appended the codes of the decisions after them. A
 * decision that is replayed with another body is `IDEMPOTENCY_KEY_REUSED` (422, in `submit.ts`), and one aimed at a
 * response or unit that is not in the caller's org is `NOT_FOUND`.
 *
 * The three 403s here are refusals the route audits itself, as a denied `review.decided` record on the audit pool, so
 * the error handler adds no second `request.authorize` record for them (`ProblemError` with `audited: true`).
 */
export const REVIEWS_PROBLEMS = {
  // The member is in the org but their role does not carry submissions.review, or they are suspended: a group of checkers
  // must never hold someone who could not decide. The permission is read at the time of adding, and again by review_decide().
  NOT_A_REVIEWER: { status: 422, title: 'That member cannot review responses' },
  // A group that was archived takes no new checkers (it stays readable, because decisions and review rows name it).
  REVIEW_GROUP_ARCHIVED: { status: 409, title: 'That review group is archived' },
  // PUT .../review named a revision that is no longer the stored one: someone else saved first, so reload and merge.
  REVIEW_SETTINGS_CONFLICT: { status: 409, title: 'The review settings changed since they were read' },
  // PUT .../review without If-Match: a save that does not say which revision it read would overwrite blindly.
  REVIEW_SETTINGS_REV_REQUIRED: { status: 428, title: 'Send the revision you read in If-Match' },
  // The four-eyes rule (WFL-09): the checker filled the unit in, was the last to change it, is a member whose verified email
  // the respondent gave, or (with distinctCheckers) has decided another unit of this response already.
  FOUR_EYES_VIOLATION: { status: 403, title: 'You cannot decide a unit you filled in, changed, or that is about you' },
  // The caller holds submissions.review but is not an active member of the group the unit was assigned to when it was opened.
  NOT_IN_REVIEW_GROUP: { status: 403, title: 'You are not a checker of this review unit' },
  // The org requires two-factor sign-in of checkers (org_settings.review_checkers_mfa) and the session did not use it.
  MFA_REQUIRED: { status: 403, title: 'Checking responses needs two-factor sign-in' },
  // The unit's answers changed since the checker read them: the decision names the hash of what they saw, and it is not the current one.
  REVIEW_STALE: { status: 409, title: 'The answers changed since you read them' },
  // A required unit of a lower order is not yet approved, so this one waits.
  REVIEW_ORDER_BLOCKED: { status: 409, title: 'An earlier review step is not approved yet' },
  // The unit was decided already (by someone else, or an earlier request of yours with another key), or the response is final.
  REVIEW_CLOSED: { status: 409, title: 'That unit is no longer waiting for a decision' },
} as const satisfies Record<string, ProblemSpec>;
