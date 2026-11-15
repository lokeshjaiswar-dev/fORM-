import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the approvals domain: review groups, review settings, the review queue and decisions (WP-2.33). Spread
 * into `PROBLEMS` by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 *
 * The setup task wrote the codes of the groups and the settings; the review queue task appends the codes of the decisions after them.
 */
export const REVIEWS_PROBLEMS = {
  // The member is in the org but their role does not carry submissions.review, or they are suspended: a group of checkers
  // must never hold someone who could not decide. The permission is read at the time of adding, and again by review_decide().
  NOT_A_REVIEWER: { status: 422, title: 'That member cannot review responses' },
  // A group that was archived takes no new checkers (it stays readable, because decisions and review rows name it).
  REVIEW_GROUP_ARCHIVED: { status: 409, title: 'That review group is archived' },
} as const satisfies Record<string, ProblemSpec>;
