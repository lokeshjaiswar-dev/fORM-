import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the builder's responses API: list, detail, flags, bulk actions and delete forever (WP-1.15). Spread
 * into `PROBLEMS` by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 *
 * A list cursor that is not valid is `INVALID_CURSOR` (the forms list's code, in `forms.ts`), and a form or response
 * that is not in the caller's org is `NOT_FOUND`, the same answer for "not yours" and "not there".
 */
export const SUBMISSIONS_PROBLEMS = {
  // Delete forever on a response that is not in the trash. Nothing in the request was deleted: the whole call is refused,
  // so a mixed selection cannot remove a live response by mistake.
  SUBMISSION_NOT_TRASHED: { status: 409, title: 'Only responses in the trash can be deleted forever' },
  // Delete forever on a response under a legal hold or inside its statutory retention period (WP-1.22 sets both).
  // The whole call is refused, as above.
  SUBMISSION_HELD: { status: 409, title: 'A response under a hold cannot be deleted' },
} as const satisfies Record<string, ProblemSpec>;
