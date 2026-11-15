import { z } from 'zod';
import { ApiProblem, ApiUnreachable, ensureSession, orgApi } from '@/auth/client';
import type { StoredSubmission, SubmissionSummary } from '@/persistence/SubmissionsRepository';

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

// The page still reads responses through these until it moves to the grid API above.
const legacyListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      formId: z.string(),
      submittedAt: z.string(),
      fieldCount: z.number(),
    }),
  ),
});
const legacyDetailSchema = z.object({
  id: z.string(),
  formId: z.string(),
  submittedAt: z.string(),
  locale: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  fields: z.array(z.object({ key: z.string(), label: z.string(), value: z.string() })),
});

async function signedIn(): Promise<boolean> {
  return (await ensureSession()).status === 'signed_in';
}

/** Best-effort API calls: signed-out or unreachable servers are ignored. */
async function quiet<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiUnreachable || err instanceof ApiProblem) return null;
    return null;
  }
}

/**
 * Responses are read only by signed-in members of the form's org (`submissions.read`, under the database's row
 * security). The session cookie and the active org ride on `orgApi`; a signed-out visitor sees the local ones only.
 */
export async function listRemoteSubmissions(formId: string): Promise<SubmissionSummary[] | null> {
  if (!(await signedIn())) return null;
  const res = await quiet(() => orgApi('GET', `/v1/forms/${formId}/submissions`, legacyListSchema));
  return res?.items ?? null;
}

/** One response from the API, marked as the server's: its rows are the ones the server built, and the page shows those. */
export async function getRemoteSubmission(formId: string, id: string): Promise<StoredSubmission | null> {
  if (!(await signedIn())) return null;
  const row = await quiet(() => orgApi('GET', `/v1/forms/${formId}/submissions/${id}`, legacyDetailSchema));
  return row ? { ...row, source: 'server' } : null;
}
