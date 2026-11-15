import type { FastifyInstance } from 'fastify';
import type { ReviewModuleDeps } from './context.ts';

/**
 * Review groups of an org and their members: `/v1/org/review-groups` (WP-2.33). A stub until the approvals setup task
 * fills it; it registers nothing yet.
 */
export function registerReviewGroups(_app: FastifyInstance, _deps: ReviewModuleDeps): void {}
