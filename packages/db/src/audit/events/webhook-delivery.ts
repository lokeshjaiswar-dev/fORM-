import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of webhook delivery: what the worker does with a queued delivery (WP-1.18). Spread into `AUDIT_EVENTS`
 * by `../catalogue.ts`; add codes here, not there. List only codes something emits (`catalogue.test.ts`), and none that
 * another file already lists (`events.test.ts`).
 *
 * Kept apart from `webhooks.ts` because the worker emits these and the API emits those, so two parallel tasks never edit
 * one file. Empty until the webhook worker task lists its codes.
 */
export const WEBHOOK_DELIVERY_EVENTS = {} as const satisfies Record<string, AuditEventSpec>;
