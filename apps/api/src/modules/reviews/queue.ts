import type { FastifyInstance } from 'fastify';
import type { ReviewModuleDeps } from './context.ts';

/**
 * The review queue: the held responses a reviewer may open (WP-2.33). A stub until the review queue task fills it; it
 * registers nothing yet.
 */
export function registerReviewQueue(_app: FastifyInstance, _deps: ReviewModuleDeps): void {}
