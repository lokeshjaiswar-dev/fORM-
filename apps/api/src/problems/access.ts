import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the access domain: a form's access settings and the password unlock (WP-1.07). Spread into
 * `PROBLEMS` by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 */
export const ACCESS_PROBLEMS = {} as const satisfies Record<string, ProblemSpec>;
