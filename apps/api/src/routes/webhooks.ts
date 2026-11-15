import type { FastifyInstance } from 'fastify';
import type { EditionConfig } from '@form/config';
import type { Db } from '@form/db';
import type { EgressGuard, KeyProvider, Queue } from '@form/ports';

export interface WebhookRouteDeps {
  /** The request pool: every read and write goes through `withTenant` on it, so row-level security limits it to the caller's org. */
  db: Db;
  /** The small separate pool for denied and failed audit records (ADR-0006). */
  auditDb: Db;
  /** Seals the signing secret under the org's key context (`sealOrgSecret`); without it the routes that make one answer 503. */
  keys?: KeyProvider | undefined;
  /** Core's producer queue: a replay sends `webhook.deliver` through it inside the transaction that inserts the delivery. */
  queue?: Queue | undefined;
  /** Keys the IP hash of audit records (`config.auth.secret`). */
  secret: Uint8Array;
  now: () => Date;
  /** The egress check of a webhook URL (the composition root passes it once the webhooks are wired). */
  tenantEgress?: EgressGuard | undefined;
  /** Which URL schemes the deployment allows (`EGRESS_POLICY`); passed with `tenantEgress`. */
  edition?: EditionConfig | undefined;
}

/**
 * A form's webhooks and their delivery log: `/v1/forms/:formId/webhooks` (WP-1.18). A stub until the webhook API task
 * fills it; it registers nothing yet, so every route it adds needs a case in `test/isolation-cases/webhooks.ts`.
 */
export function webhookRoutes(_app: FastifyInstance, _deps: WebhookRouteDeps): void {}
