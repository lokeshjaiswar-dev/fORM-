import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of server-side lookups: the org's API credentials (a sealed `ApiAuth` a form's lookup, option list or check
 * names by id). A record names the credential's id, its kind of authentication and the keys that changed; never the secret, its
 * last characters, the host it is bound to or the header name. Spread into `AUDIT_EVENTS` by `../catalogue.ts`.
 */
export const REMOTE_EVENTS = {
  'api_credential.saved': {
    outcomes: ['success'],
    resourceType: 'api_credential',
    description:
      'An org API credential was created, changed or rotated (`change` is `created`, `updated` or `rotated`); the metadata names the keys that changed (`name`, `host`, `auth`), never the secret.',
  },
  'api_credential.deleted': {
    outcomes: ['success'],
    resourceType: 'api_credential',
    description: 'An org API credential and its sealed secret were deleted.',
  },
} as const satisfies Record<string, AuditEventSpec>;
