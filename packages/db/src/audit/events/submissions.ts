import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the submissions domain: the submit pipeline, the responses reads and exports (WP-1.12, WP-1.15).
 * Spread into `AUDIT_EVENTS` by `../catalogue.ts`; add codes here, not there. List only codes something emits
 * (`catalogue.test.ts`), and none that another file already lists (`events.test.ts`).
 */
export const SUBMISSIONS_EVENTS = {} as const satisfies Record<string, AuditEventSpec>;
