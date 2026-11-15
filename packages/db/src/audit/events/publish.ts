import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the publish domain: versions and FormOps (WP-1.07). Spread into `AUDIT_EVENTS` by `../catalogue.ts`;
 * add codes here, not there. List only codes something emits (`catalogue.test.ts`), and none that another file already
 * lists (`events.test.ts`).
 */
export const PUBLISH_EVENTS = {} as const satisfies Record<string, AuditEventSpec>;
