import { z } from 'zod';
import { orgApi } from '@/auth/client';

/*
 * The builder's side of the responses API (WP-1.15, apps/api/src/routes/submissions.ts): the grid, one response, the
 * inbox flags and the bulk actions. Every call is for a signed-in member of the active org (`orgApi` adds the session
 * cookie and `X-FR-Org`); the Responses page sits behind the session gate, so these do not look at the session
 * themselves, and a refusal reaches the page as an `ApiProblem` for it to say so. The schemas read only what the page
 * shows, and leave the rest of a response alone: `status` is a plain string so a status the API adds later does not
 * make every response unreadable.
 */

/** Where a response is filed in the member's inbox. */
export const VIEWS = ['inbox', 'archived', 'trash'] as const;
export type View = (typeof VIEWS)[number];

/** The most responses one bulk call names; the API refuses more, and the page stops a selection at this many. */
export const MAX_BULK = 500;
/** Rows asked for in one page of the grid (the API's own default; its limit is 200). */
export const PAGE_SIZE = 50;

const gridColumnSchema = z.object({
  /** The block id, the same in every version of the form that has the field. */
  id: z.string(),
  key: z.string(),
  label: z.string(),
  type: z.string(),
});
export type GridColumn = z.infer<typeof gridColumnSchema>;

const gridRowSchema = z.object({
  id: z.string(),
  receivedAt: z.string(),
  status: z.string(),
  read: z.boolean(),
  starred: z.boolean(),
  archivedAt: z.string().nullable(),
  trashedAt: z.string().nullable(),
  versionNumber: z.number().nullable(),
  /** The answered fields as text, by column id. */
  cells: z.record(z.string(), z.string()),
  /** The column ids whose cell is the mask: the field is encrypted or sensitive. */
  masked: z.array(z.string()),
});
export type GridRow = z.infer<typeof gridRowSchema>;

const gridPageSchema = z.object({
  columns: z.array(gridColumnSchema),
  items: z.array(gridRowSchema),
  nextCursor: z.string().nullable(),
});
export type GridPage = z.infer<typeof gridPageSchema>;

const detailFieldSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  type: z.string(),
  value: z.string(),
  masked: z.boolean(),
});
export type DetailField = z.infer<typeof detailFieldSchema>;

const detailFileSchema = z.object({
  /** Null for a file in a protected field: it cannot be fetched from here. */
  id: z.string().nullable(),
  blockId: z.string(),
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number().nullable(),
  purpose: z.string(),
  masked: z.boolean(),
});
export type DetailFile = z.infer<typeof detailFileSchema>;

/** One review unit of a response that was held for review (WP-2.33): its name and where it stands. The key is absent for any other response. */
const reviewSummarySchema = z.array(z.object({ name: z.string(), state: z.string() }));

const detailSchema = z.object({
  id: z.string(),
  formId: z.string(),
  receivedAt: z.string(),
  status: z.string(),
  read: z.boolean(),
  starred: z.boolean(),
  archivedAt: z.string().nullable(),
  trashedAt: z.string().nullable(),
  versionNumber: z.number().nullable(),
  locale: z.string(),
  fields: z.array(detailFieldSchema),
  files: z.array(detailFileSchema),
  review: reviewSummarySchema.optional(),
});
export type SubmissionDetail = z.infer<typeof detailSchema>;

const flagsSchema = z.object({ id: z.string(), read: z.boolean(), starred: z.boolean() });
export type SubmissionFlags = z.infer<typeof flagsSchema>;

export const BULK_ACTIONS = ['mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'unarchive', 'trash', 'restore', 'delete'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

const bulkResultSchema = z.object({
  action: z.string(),
  requested: z.number(),
  changed: z.number(),
  unchanged: z.number(),
  missing: z.number(),
  removedFiles: z.number(),
});
export type BulkResult = z.infer<typeof bulkResultSchema>;

/** What narrows a page of the grid. `view` is always sent; the rest only when set. */
export interface GridQuery {
  view: View;
  /** Words to find in the non-sensitive answers. */
  q?: string | undefined;
  /** An ISO instant: received at or after it. */
  from?: string | undefined;
  /** An ISO instant: received at or before it. */
  to?: string | undefined;
  read?: boolean | undefined;
  starred?: boolean | undefined;
  /** The processing state, such as `complete` or `spam`. */
  status?: string | undefined;
}

const formPath = (formId: string) => `/v1/forms/${encodeURIComponent(formId)}/submissions`;

/**
 * The URL of one page of the grid. `cursor` is the API's signed `nextCursor`, passed back unchanged with the same
 * filters (the API refuses it for any other query). Empty and unset filters are left out.
 */
export function gridPath(formId: string, query: GridQuery, cursor?: string | null): string {
  const params = new URLSearchParams({ view: query.view, limit: String(PAGE_SIZE) });
  const q = query.q?.trim();
  if (q) params.set('q', q);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.read !== undefined) params.set('read', String(query.read));
  if (query.starred !== undefined) params.set('starred', String(query.starred));
  if (query.status) params.set('status', query.status);
  if (cursor) params.set('cursor', cursor);
  return `${formPath(formId)}?${params.toString()}`;
}

/** One page of a form's responses: the columns of every version, the rows, and where the next page starts (null on the last). */
export function listSubmissions(formId: string, query: GridQuery, cursor?: string | null): Promise<GridPage> {
  return orgApi('GET', gridPath(formId, query, cursor), gridPageSchema);
}

/** One response in full: its fields as the server built them (protected answers masked) and the files it holds. */
export function getSubmission(formId: string, id: string): Promise<SubmissionDetail> {
  return orgApi('GET', `${formPath(formId)}/${encodeURIComponent(id)}`, detailSchema);
}

/** Marks a response read or unread, starred or not. A flag already at the asked value changes nothing. */
export function patchSubmission(formId: string, id: string, change: { read?: boolean; starred?: boolean }): Promise<SubmissionFlags> {
  return orgApi('PATCH', `${formPath(formId)}/${encodeURIComponent(id)}`, flagsSchema, change);
}

/**
 * One action on up to `MAX_BULK` responses, all in one transaction on the server. `delete` removes forever, and the
 * server refuses the whole call unless every response named is in the trash.
 */
export function bulkSubmissions(formId: string, action: BulkAction, ids: readonly string[]): Promise<BulkResult> {
  if (ids.length === 0 || ids.length > MAX_BULK) throw new RangeError(`a bulk action names 1 to ${MAX_BULK} responses`);
  return orgApi('POST', `${formPath(formId)}/bulk`, bulkResultSchema, { action, ids: [...ids] });
}
