import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the exports domain: requesting, listing and downloading a submissions export (WP-1.17). Spread into
 * `PROBLEMS` by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 *
 * Empty until the exports task adds its codes.
 */
export const EXPORTS_PROBLEMS = {} as const satisfies Record<string, ProblemSpec>;
