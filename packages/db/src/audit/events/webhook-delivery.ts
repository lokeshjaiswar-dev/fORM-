import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of webhook delivery: what the worker does with a queued delivery (WP-1.18). Spread into `AUDIT_EVENTS`
 * by `../catalogue.ts`; add codes here, not there. List only codes something emits (`catalogue.test.ts`), and none that
 * another file already lists (`events.test.ts`).
 *
 * Kept apart from `webhooks.ts` because the worker emits these and the API emits those, so two parallel tasks never edit
 * one file. A delivery itself is not audited: the delivery log (`webhook_deliveries`) and the disclosures ledger are its
 * record. Only the automatic turn-off is, because it changes the owner's settings without anyone asking.
 */
export const WEBHOOK_DELIVERY_EVENTS = {
  'webhook.disabled': {
    outcomes: ['success'],
    resourceType: 'webhook',
    description:
      'The worker turned a webhook off by itself after 50 failed deliveries in a row (the count, the last status and the delivery id in metadata, never the address, a secret or an answer). The owner turns it on again after fixing the receiver.',
  },
} as const satisfies Record<string, AuditEventSpec>;
