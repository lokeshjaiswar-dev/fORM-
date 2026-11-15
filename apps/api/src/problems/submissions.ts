import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the builder's responses API: list, detail, reveal and export of submissions (WP-1.15). Spread into
 * `PROBLEMS` by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 */
export const SUBMISSIONS_PROBLEMS = {} as const satisfies Record<string, ProblemSpec>;
