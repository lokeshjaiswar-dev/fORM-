import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the approvals domain: review groups, review settings and the decisions on held responses (WP-2.33).
 * Spread into `AUDIT_EVENTS` by `../catalogue.ts`; add codes here, not there. List only codes something emits
 * (`catalogue.test.ts`), and none that another file already lists (`events.test.ts`).
 *
 * Empty until the approvals tasks list their codes (the setup writes, `review.opened`, `review.decided`,
 * `review.finalised`). The API appends them in the same transaction as the definer call; the SQL definers append nothing.
 */
export const REVIEWS_EVENTS = {} as const satisfies Record<string, AuditEventSpec>;
