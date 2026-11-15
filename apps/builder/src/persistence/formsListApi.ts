import { z } from 'zod';
import { api } from '@/auth/client';

/*
 * The forms list as the builder shows it (WP-1.06, BL-267): the server's own pages (`GET /v1/forms`: search, sort,
 * favourites, lifecycle, signed cursors) and the one-form verbs on the same routes (star, clone, archive, restore).
 * Moving a form to the trash is not here: it goes through `DocumentRepository.remove`, which also drops the form from
 * this browser's cache.
 *
 * Every call names its org (`X-FR-Org`), like `draftsApi`: a call that is still in flight when the author switches orgs
 * must not be sent to the new one. The calls throw `ApiProblem` for a refusal and `ApiUnreachable` when nothing
 * answers or the answer is not what the page can read (see `api` in `auth/client.ts`); the list page decides what to say.
 */

/** Where a form is filed. `trashed` is the trash: restorable, and never purged yet (no hard delete exists). */
export const FORM_LIFECYCLES = ['active', 'archived', 'trashed'] as const;
export type FormLifecycle = (typeof FORM_LIFECYCLES)[number];

/** What the list can be ordered by. The API picks the direction: newest first for dates, A to Z for titles. */
export const FORM_SORTS = ['updated', 'created', 'title'] as const;
export type FormSort = (typeof FORM_SORTS)[number];

/** Forms asked for in one page. The API's own default; its limit is 200. */
export const PAGE_SIZE = 50;
/** The longest search the API accepts (`q`, 100 characters). */
export const MAX_SEARCH = 100;

/** One row of `GET /v1/forms`, as far as the list shows it. */
const formRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  lifecycle: z.enum(FORM_LIFECYCLES),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Whether the signed-in member starred the form; stars are personal. */
  favourite: z.boolean(),
  /** The server's own count of responses to the form. */
  submissionCount: z.number().int().nonnegative(),
  /** An active form with a published version: its public link opens. */
  isLive: z.boolean(),
});
export type FormRow = z.infer<typeof formRowSchema>;

const pageSchema = z.object({ items: z.array(formRowSchema), nextCursor: z.string().nullable() });
export type FormsPage = z.infer<typeof pageSchema>;

/** What a page of the list is asked for: everything that changes which rows come in which order. */
export interface FormsQuery {
  lifecycle: FormLifecycle;
  /** Words in the title; empty for all forms. */
  q: string;
  sort: FormSort;
  /** Only the forms the member starred. */
  favourite: boolean;
}

/** The query string of one page. A cursor is bound by the server to the exact query it came from, so it is only ever sent with that query. */
export function pageQuery(query: FormsQuery, cursor: string | null): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), lifecycle: query.lifecycle, sort: query.sort });
  const q = query.q.trim().slice(0, MAX_SEARCH);
  if (q) params.set('q', q);
  // Only `true` is a filter on the API; the parameter is left out for all forms.
  if (query.favourite) params.set('favourite', 'true');
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

/** One page of the forms in `org`; `cursor` is the `nextCursor` of the page before it, for the same query. */
export function fetchFormsPage(org: string, query: FormsQuery, cursor: string | null = null): Promise<FormsPage> {
  return api('GET', `/v1/forms?${pageQuery(query, cursor)}`, pageSchema, undefined, { org });
}

const idPath = (id: string) => `/v1/forms/${encodeURIComponent(id)}`;

/** Stars (`true`) or unstars a form for the signed-in member. Repeating a call changes nothing. */
export async function setFavourite(org: string, id: string, star: boolean): Promise<boolean> {
  const done = await api(star ? 'PUT' : 'DELETE', `${idPath(id)}/favourite`, z.object({ favourite: z.boolean() }), undefined, { org });
  return done.favourite;
}

/** Copies a form as a new draft titled "Copy of …" (the API makes the id). */
export function cloneForm(org: string, id: string): Promise<FormRow> {
  return api('POST', `${idPath(id)}/clone`, formRowSchema, {}, { org });
}

/** Takes an active form out of the main list without deleting it. */
export function archiveForm(org: string, id: string): Promise<FormRow> {
  return api('POST', `${idPath(id)}/archive`, formRowSchema, {}, { org });
}

/** Makes an archived or trashed form active again (the API's restore covers both). */
export function restoreForm(org: string, id: string): Promise<FormRow> {
  return api('POST', `${idPath(id)}/restore`, formRowSchema, {}, { org });
}
