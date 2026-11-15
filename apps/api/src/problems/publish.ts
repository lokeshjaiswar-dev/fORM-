import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the publish domain: publish checks, versions and FormOps (WP-1.07). Spread into `PROBLEMS` by
 * `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 */
export const PUBLISH_PROBLEMS = {} as const satisfies Record<string, ProblemSpec>;
