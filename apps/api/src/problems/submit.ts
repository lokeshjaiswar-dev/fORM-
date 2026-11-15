import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of a respondent's submit: the refusals of `POST /v1/p/:slug/submissions` (WP-1.12), such as an invalid
 * answer (422) or a form version that was superseded (409). Spread into `PROBLEMS` by `../errors.ts`; add codes here,
 * not there. A code appears in one file only (`problems.test.ts`).
 */
export const SUBMIT_PROBLEMS = {} as const satisfies Record<string, ProblemSpec>;
