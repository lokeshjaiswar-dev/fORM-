import type { FastifyInstance } from 'fastify';
import type { ReviewModuleDeps } from './context.ts';

/**
 * A reviewer's decision on a held response: approve or reject with a reason code (WP-2.33). A stub until the review queue
 * task fills it; it registers nothing yet.
 */
export function registerReviewDecide(_app: FastifyInstance, _deps: ReviewModuleDeps): void {}
