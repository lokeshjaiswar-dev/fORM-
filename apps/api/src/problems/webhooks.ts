import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the webhooks domain: a form's webhook settings and its delivery log (WP-1.18). Spread into `PROBLEMS`
 * by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 *
 * Empty until the webhook API task adds its codes.
 */
export const WEBHOOKS_PROBLEMS = {} as const satisfies Record<string, ProblemSpec>;
