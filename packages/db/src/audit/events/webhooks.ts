import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the webhooks domain: the webhook settings of a form and its delivery log reads (WP-1.18). Spread into
 * `AUDIT_EVENTS` by `../catalogue.ts`; add codes here, not there. List only codes something emits (`catalogue.test.ts`),
 * and none that another file already lists (`events.test.ts`).
 *
 * Empty until the webhook API task lists its codes. A record never carries a signing secret or the query of a target URL.
 * What the worker does with a queued delivery is listed in `webhook-delivery.ts`.
 */
export const WEBHOOKS_EVENTS = {} as const satisfies Record<string, AuditEventSpec>;
