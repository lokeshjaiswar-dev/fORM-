import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the webhooks domain: the webhook settings of a form and its signing secret (WP-1.18). Spread into
 * `AUDIT_EVENTS` by `../catalogue.ts`; add codes here, not there. List only codes something emits (`catalogue.test.ts`),
 * and none that another file already lists (`events.test.ts`).
 *
 * A record names the webhook, its form and the host of its URL (never the path or the query, which may carry a token),
 * and never a signing secret or any part of one. What the worker does with a queued delivery is listed in
 * `webhook-delivery.ts`.
 */
export const WEBHOOKS_EVENTS = {
  'webhook.saved': {
    outcomes: ['success'],
    resourceType: 'webhook',
    description:
      'A webhook was created or its settings were saved; the metadata says which (`change`), names the host of the URL, the events and the purpose ids, and for a save the keys that changed and the new revision. A creation also issues the signing secret (shown once, never recorded).',
  },
  'webhook.deleted': {
    outcomes: ['success'],
    resourceType: 'webhook',
    description: 'A webhook was deleted with its signing secret and its delivery log; the metadata names the host of the URL it had.',
  },
  'webhook.secret_rotated': {
    outcomes: ['success'],
    resourceType: 'webhook',
    description: "A webhook's signing secret was replaced by a new one (shown once); the old one stops verifying at once. Never the secret itself.",
  },
  'webhook.replayed': {
    outcomes: ['success'],
    resourceType: 'webhook',
    description:
      'A member asked for an earlier delivery to be sent again: a new delivery was queued with the same event and response. The metadata names the new delivery, the one it replays and the event.',
  },
} as const satisfies Record<string, AuditEventSpec>;
