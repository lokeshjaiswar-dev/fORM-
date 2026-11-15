import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the submissions domain: the submit pipeline, the responses reads and exports (WP-1.12, WP-1.15).
 * Spread into `AUDIT_EVENTS` by `../catalogue.ts`; add codes here, not there. List only codes something emits
 * (`catalogue.test.ts`), and none that another file already lists (`events.test.ts`).
 *
 * The reads of the inbox (`submission.viewed`, `submission.page_viewed`, `submission.api_read`, `submission.revealed`,
 * `submission.exported`) stay in the shared catalogue, where they were listed before the per-domain files. The writes of
 * the inbox (the flags on a response, archive, trash, restore, delete forever) are listed here. Their metadata carries
 * ids and counts, never answers; a record holds at most `auditIdChunks()` ids, so a bulk action over 500 responses
 * leaves several records that together name every id.
 */
export const SUBMISSIONS_EVENTS = {
  'submission.updated': {
    outcomes: ['success'],
    resourceType: 'submission',
    description:
      'A member changed the inbox state of responses: read or unread, starred or not, archived or taken out of the archive (the operation, the count and the ids in metadata, never the answers).',
  },
  'submission.trashed': {
    outcomes: ['success'],
    resourceType: 'submission',
    description: 'Responses were moved to the trash of their form. They stay readable there until they are restored or deleted forever.',
  },
  'submission.restored': {
    outcomes: ['success'],
    resourceType: 'submission',
    description: 'Responses were taken out of the trash and went back to where they were (the inbox or the archive).',
  },
  'submission.purged': {
    outcomes: ['success'],
    resourceType: 'submission',
    description:
      'Trashed responses were deleted forever, with their search documents, their uploaded files and the file bytes (the ids and the counts of what went with them in metadata).',
  },
} as const satisfies Record<string, AuditEventSpec>;
