import type { FastifyInstance } from 'fastify';
import type { ReviewModuleDeps } from './context.ts';
import { registerReviewDecide } from './decide.ts';
import { registerReviewGroups } from './groups.ts';
import { registerReviewQueue } from './queue.ts';
import { registerReviewSettings } from './settings.ts';

export type { ReviewModuleDeps } from './context.ts';

/**
 * Approvals (WP-2.33): review groups and a form's review settings (`groups.ts`, `settings.ts`), the review queue and the
 * decisions on held responses (`queue.ts`, `decide.ts`). Permissions are checked by the auth preHandler (`config.perm`)
 * and again by RLS.
 *
 * This file only lists the parts, so the tasks that fill them never edit it. Each part is empty until its owner adds the
 * routes, and every `auth: 'user'` route it adds needs a case in `test/isolation-cases/reviews.ts`.
 */
export function registerReviewModule(app: FastifyInstance, deps: ReviewModuleDeps): void {
  registerReviewGroups(app, deps);
  registerReviewSettings(app, deps);
  registerReviewQueue(app, deps);
  registerReviewDecide(app, deps);
}
