import { SUBMISSION_STATUSES } from '@form/db';
import { z } from 'zod';
import { MAX_CURSOR_LENGTH } from '../cursor.ts';

const isoInstant = z.iso.datetime({ offset: true });

/** Where a response is filed in the member's inbox: the inbox, the archive, or the trash. */
export const VIEWS = ['inbox', 'archived', 'trash'] as const;
export type View = (typeof VIEWS)[number];

/** The most responses one request names, in a page or a bulk action. */
export const MAX_PAGE = 200;
export const MAX_BULK = 500;
/** What a search takes: the SearchIndex adapter's own limit. */
export const MAX_QUERY = 256;

export const gridQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(50),
    /** Signed by the API, bound to this exact query (filters, view, search, caller): pass it back unchanged for the next page. */
    cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
    /** Received at or after this moment. */
    from: isoInstant.optional(),
    /** Received at or before this moment. */
    to: isoInstant.optional(),
    /** The processing state: `complete`, `spam`, or a held one such as `pending_payment`. */
    status: z.enum(SUBMISSION_STATUSES).optional(),
    read: z.enum(['true', 'false']).optional(),
    starred: z.enum(['true', 'false']).optional(),
    view: z.enum(VIEWS).default('inbox'),
    /** Words to find in the non-sensitive answers; the page is then in order of relevance, not of time. An empty value is no search. */
    q: z.string().trim().max(MAX_QUERY).optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || Date.parse(q.from) <= Date.parse(q.to), { message: '`from` must not be after `to`', path: ['from'] });

export type GridQuery = z.infer<typeof gridQuery>;

export const gridColumn = z.object({
  /** The block id, which is the same in every version of the form that has the field. */
  id: z.string(),
  key: z.string(),
  /** The newest version's label for the field. */
  label: z.string(),
  type: z.string(),
});

export const gridItem = z.object({
  id: z.uuid(),
  receivedAt: isoInstant,
  status: z.enum(SUBMISSION_STATUSES),
  read: z.boolean(),
  starred: z.boolean(),
  archivedAt: isoInstant.nullable(),
  trashedAt: isoInstant.nullable(),
  /** The number of the version the response was received on; 0 for a response filed under the stand-in of a never-published form. */
  versionNumber: z.number().int().nullable(),
  /** The answered fields as text, by column id. */
  cells: z.record(z.string(), z.string()),
  /** The column ids whose cell is the mask because the field is encrypted or sensitive. */
  masked: z.array(z.string()),
});

export const gridResponse = z.object({
  columns: z.array(gridColumn),
  items: z.array(gridItem),
  /** Null on the last page. */
  nextCursor: z.string().nullable(),
});

export const detailField = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  type: z.string(),
  value: z.string(),
  masked: z.boolean(),
});

export const detailFile = z.object({
  /** Null for a file in a masked field: it cannot be fetched from here until it can be revealed. */
  id: z.uuid().nullable(),
  blockId: z.string(),
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nullable(),
  purpose: z.enum(['file', 'signature']),
  masked: z.boolean(),
});

export const detailResponse = z.object({
  id: z.uuid(),
  formId: z.uuid(),
  receivedAt: isoInstant,
  status: z.enum(SUBMISSION_STATUSES),
  read: z.boolean(),
  starred: z.boolean(),
  archivedAt: isoInstant.nullable(),
  trashedAt: isoInstant.nullable(),
  versionId: z.uuid(),
  versionNumber: z.number().int().nullable(),
  locale: z.string(),
  /** What the server recorded about the request (page, referrer host, device, timings); never a hash of the address. */
  meta: z.record(z.string(), z.unknown()),
  fields: z.array(detailField),
  /** The stored answers by block id; a protected one is `{ type, masked: true }`. */
  answers: z.record(z.string(), z.unknown()),
  files: z.array(detailFile),
});

export const patchBody = z
  .strictObject({ read: z.boolean().optional(), starred: z.boolean().optional() })
  .refine((b) => b.read !== undefined || b.starred !== undefined, { message: 'Send `read`, `starred`, or both.' });

export const patchResponse = z.object({ id: z.uuid(), read: z.boolean(), starred: z.boolean() });

export const BULK_ACTIONS = ['mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'unarchive', 'trash', 'restore', 'delete'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export const bulkBody = z.strictObject({
  ids: z.array(z.uuid()).min(1).max(MAX_BULK),
  action: z.enum(BULK_ACTIONS),
});

export const bulkResponse = z.object({
  action: z.enum(BULK_ACTIONS),
  /** The distinct ids in the request. */
  requested: z.number().int(),
  /** Responses the action changed (for `delete`, removed). */
  changed: z.number().int(),
  /** Responses that were already in the state the action asks for. */
  unchanged: z.number().int(),
  /** Ids that are not responses of this form: never received here, or already deleted. */
  missing: z.number().int(),
  /** `delete` only: the uploaded files removed with the responses. */
  removedFiles: z.number().int(),
});
