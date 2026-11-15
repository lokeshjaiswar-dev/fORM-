import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the forms domain: CRUD, drafts, the forms list, trash and restore (WP-1.06). Spread into
 * `AUDIT_EVENTS` by `../catalogue.ts`, so a work package adds its codes to its own domain file and never edits the shared
 * one (fewer merge conflicts). List only codes something emits: `catalogue.test.ts` fails for a code no `audit.append()`
 * call names, and `events.test.ts` for a code that another file already lists.
 */
export const FORMS_EVENTS = {
  'form.archived': {
    outcomes: ['success'],
    resourceType: 'form',
    description: 'A form was archived: it left the active list and its public link stopped resolving. The previous state is in the metadata.',
  },
  'form.trashed': {
    outcomes: ['success'],
    resourceType: 'form',
    description: 'A form was moved to the trash (not deleted): hidden from the lists and its public link stopped resolving until it is restored.',
  },
  'form.restored': {
    outcomes: ['success'],
    resourceType: 'form',
    description: 'An archived or trashed form was made active again. The previous state is in the metadata.',
  },
  'form.cloned': {
    outcomes: ['success'],
    resourceType: 'form',
    description: 'A form was copied: the resource is the new form and the source form is in the metadata. Access settings and the live version are not copied.',
  },
  'form.imported': {
    outcomes: ['success'],
    resourceType: 'form',
    description:
      'A v1 form was imported and stored as a v2 draft. The metadata says whether a form password was hashed into the access settings (never the password), whether the form came in closed, and how many migration notes there were.',
  },
} as const satisfies Record<string, AuditEventSpec>;
