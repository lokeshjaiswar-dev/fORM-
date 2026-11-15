import type { FastifyInstance } from 'fastify';
import type { Db } from '@form/db';
import type { KeyProvider, Mailer } from '@form/ports';

export interface EmailSenderRouteDeps {
  /** The request pool: every read and write goes through `withTenant` on it, so row-level security limits it to the caller's org. */
  db: Db;
  /** The small separate pool for denied and failed audit records (ADR-0006). */
  auditDb: Db;
  /** Seals an SMTP URL under the org's key context (`sealOrgSecret`); without it the routes that store one answer 503. */
  keys?: KeyProvider | undefined;
  /** Keys the IP hash of audit records (`config.auth.secret`). */
  secret: Uint8Array;
  now: () => Date;
  /** The mailer of one org's sender, for the test message (the composition root passes it once the notifications are wired). */
  orgMailer?: ((orgId: string) => Mailer) | undefined;
}

/**
 * The org's email senders: `/v1/email-senders` (WP-1.16). A stub until the notification API task fills it; it registers
 * nothing yet, so every route it adds needs a case in `test/isolation-cases/notifications.ts`.
 */
export function emailSenderRoutes(_app: FastifyInstance, _deps: EmailSenderRouteDeps): void {}
