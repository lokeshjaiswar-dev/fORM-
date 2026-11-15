import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the forms domain: CRUD, drafts, the forms list, trash and restore (WP-1.06). Spread into
 * `AUDIT_EVENTS` by `../catalogue.ts`, so a work package adds its codes to its own domain file and never edits the shared
 * one (fewer merge conflicts). List only codes something emits: `catalogue.test.ts` fails for a code no `audit.append()`
 * call names, and `events.test.ts` for a code that another file already lists.
 */
export const FORMS_EVENTS = {} as const satisfies Record<string, AuditEventSpec>;
