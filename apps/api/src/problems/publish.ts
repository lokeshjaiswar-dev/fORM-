import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the publish domain: publish checks, versions and FormOps (WP-1.07). Spread into `PROBLEMS` by
 * `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 *
 * `DRAFT_REV_CONFLICT` (a stale `expectedDraftRev`) is the draft's own code and stays in `errors.ts`.
 */
export const PUBLISH_PROBLEMS = {
  /** The draft has error issues; the body's `issues` lists every one (`{ code, path, message, severity }`). */
  PUBLISH_BLOCKED: { status: 422, title: 'This form cannot be published yet' },
  /** The plan the client compiled does not hash like the server's compile of the same draft; nothing was stored. */
  PLAN_MISMATCH: { status: 422, title: 'The compiled plan does not match the draft' },
} as const satisfies Record<string, ProblemSpec>;
