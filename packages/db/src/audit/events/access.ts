import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the access domain: a form's access settings and the password unlock (WP-1.07). Spread into
 * `AUDIT_EVENTS` by `../catalogue.ts`; add codes here, not there. List only codes something emits (`catalogue.test.ts`),
 * and none that another file already lists (`events.test.ts`).
 */
export const ACCESS_EVENTS = {
  'form.access_changed': {
    outcomes: ['success'],
    resourceType: 'form',
    description:
      "A form's access settings were saved (open and close times, limit, allowlists, status screens); the metadata names the keys that changed and the new revision, never their values.",
  },
  'form.password_changed': {
    outcomes: ['success'],
    resourceType: 'form',
    description: 'A form password was set, replaced or removed (`set` or `removed` in the metadata); never the password or its hash.',
  },
  'form.slug_changed': {
    outcomes: ['success'],
    resourceType: 'form',
    description: "A form's public address was changed; the old address keeps resolving and the metadata names both.",
  },
  'form.unlock_failed': {
    outcomes: ['denied'],
    resourceType: 'form',
    description: "A respondent's password for a protected form was not accepted; filed with the keyed hash of the address only (no password, no user).",
  },
} as const satisfies Record<string, AuditEventSpec>;
