import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the exports domain: building and downloading a submissions export (WP-1.17). Spread into
 * `AUDIT_EVENTS` by `../catalogue.ts`; add codes here, not there. List only codes something emits (`catalogue.test.ts`),
 * and none that another file already lists (`events.test.ts`).
 *
 * `submission.exported` (the request for an export, written by `auditReads.export`) stays in the shared catalogue, where it
 * was listed before the per-domain files.
 */
export const EXPORTS_EVENTS = {
  'export.downloaded': {
    outcomes: ['success'],
    resourceType: 'export',
    description:
      'The requester downloaded a finished submissions export through the API; the metadata carries the format and size, never the contents. One record per download, written before the first byte is sent.',
  },
} as const satisfies Record<string, AuditEventSpec>;
