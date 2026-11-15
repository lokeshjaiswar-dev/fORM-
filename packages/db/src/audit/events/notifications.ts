import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the notifications domain: org email senders and the notifications of a form (WP-1.16). Spread into
 * `AUDIT_EVENTS` by `../catalogue.ts`; add codes here, not there. List only codes something emits (`catalogue.test.ts`),
 * and none that another file already lists (`events.test.ts`).
 *
 * Empty until the notification tasks list their codes. A record names ids and counts, never a recipient's address, a
 * sender's SMTP credentials or an answer.
 */
export const NOTIFICATIONS_EVENTS = {} as const satisfies Record<string, AuditEventSpec>;
