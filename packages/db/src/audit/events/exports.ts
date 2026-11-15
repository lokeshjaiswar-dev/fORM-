import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the exports domain: building and downloading a submissions export (WP-1.17). Spread into
 * `AUDIT_EVENTS` by `../catalogue.ts`; add codes here, not there. List only codes something emits (`catalogue.test.ts`),
 * and none that another file already lists (`events.test.ts`).
 *
 * Empty until the exports task lists its codes. `submission.exported` (the request for an export) stays in the shared
 * catalogue, where it was listed before the per-domain files.
 */
export const EXPORTS_EVENTS = {} as const satisfies Record<string, AuditEventSpec>;
