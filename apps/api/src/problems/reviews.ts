import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the approvals domain: review groups, review settings, the review queue and decisions (WP-2.33). Spread
 * into `PROBLEMS` by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 *
 * Empty until the approvals API tasks add their codes (the setup task first, the review queue task after it).
 */
export const REVIEWS_PROBLEMS = {} as const satisfies Record<string, ProblemSpec>;
