import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the notifications domain: org email senders and the notifications of a form (WP-1.16). Spread into
 * `PROBLEMS` by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 *
 * Empty until the notification API task adds its codes.
 */
export const NOTIFICATIONS_PROBLEMS = {} as const satisfies Record<string, ProblemSpec>;
