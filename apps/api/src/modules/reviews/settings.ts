import type { FastifyInstance } from 'fastify';
import type { ReviewModuleDeps } from './context.ts';

/**
 * A form's review settings: `GET` and `PUT /v1/forms/:id/review` (WP-2.33). A stub until the approvals setup task fills
 * it; it registers nothing yet.
 */
export function registerReviewSettings(_app: FastifyInstance, _deps: ReviewModuleDeps): void {}
