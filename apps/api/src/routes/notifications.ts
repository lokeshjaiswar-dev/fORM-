import type { FastifyInstance } from 'fastify';
import type { Db } from '@form/db';

export interface NotificationRouteDeps {
  /** The request pool: every read and write goes through `withTenant` on it, so row-level security limits it to the caller's org. */
  db: Db;
  /** The small separate pool for denied and failed audit records (ADR-0006). */
  auditDb: Db;
  /** Keys the IP hash of audit records (`config.auth.secret`). */
  secret: Uint8Array;
  now: () => Date;
}

/**
 * The notifications of a form and its email log: `/v1/forms/:formId/notifications` and `/v1/forms/:formId/email-log`
 * (WP-1.16). A stub until the notification API task fills it; it registers nothing yet, so every route it adds needs a
 * case in `test/isolation-cases/notifications.ts`.
 */
export function notificationRoutes(_app: FastifyInstance, _deps: NotificationRouteDeps): void {}
