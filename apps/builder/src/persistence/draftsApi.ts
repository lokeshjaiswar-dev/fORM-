import { z } from 'zod';
import type { MergeConflict, MergeResolution } from '@form/schema';
import { ApiProblem, ApiUnreachable, CLIENT_HEADERS, ORG_HEADER, activeOrgOf, useSessionStore, type Method } from '@/auth/client';
import { API_BASE } from '@/edition/edition';
import { DraftConflict, type ServerDraft } from '@/persistence/DocumentRepository';

/*
 * The forms API as the builder's repository uses it (WP-1.06). Every call names its org: a repository belongs to one
 * org (BL-231), so a call that is still in flight when the author switches orgs cannot be sent to the new one.
 */

const isoInstant = z.string();
const listSchema = z.object({
  items: z.array(z.object({ id: z.string(), title: z.string(), lifecycle: z.string(), updatedAt: isoInstant })),
  nextCursor: z.string().nullable().default(null),
});
const draftSchema = z.object({
  draftRev: z.number(),
  schemaVersion: z.number(),
  draft: z.record(z.string(), z.unknown()),
  updatedAt: isoInstant,
  updatedBy: z.string().nullable().optional(),
});
const savedSchema = z.object({ draftRev: z.number(), updatedAt: isoInstant });
const conflictSchema = z.object({
  code: z.literal('DRAFT_REV_CONFLICT'),
  draftRev: z.number(),
  updatedAt: isoInstant,
  updatedBy: z.string().nullable().optional(),
  draft: z.record(z.string(), z.unknown()).nullable(),
});

export type RemoteForm = { id: string; title: string; updatedAt: string };
export type RemoteDraft = ServerDraft & { draft: Record<string, unknown>; schemaVersion: number };
/** The server's forms of an org; `complete` is false when the list stopped at the page limit. */
export type RemoteList = { items: RemoteForm[]; complete: boolean };

/** What the API answered: the status and the JSON body (null when it sent none). */
export interface Reply {
  status: number;
  ok: boolean;
  json: unknown;
}

/** A call that stays unanswered this long counts as an unreachable API, so a dead network never holds a save (or a page) for ever. */
const TIMEOUT_MS = 20_000;

function timeout(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
}

/**
 * One call in `org` (`X-FR-Org`), with the session cookie and the CSRF header every unsafe call needs. Throws
 * `ApiUnreachable` when nothing answers; every answer, refusals included, comes back as a `Reply` for the caller to read.
 */
export async function orgCall(org: string, method: Method, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  let res: Response;
  const signal = timeout();
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(method === 'GET' ? {} : CLIENT_HEADERS),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        [ORG_HEADER]: org,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new ApiUnreachable();
  }
  const json: unknown = (res.headers.get('content-type') ?? '').includes('json') ? await res.json().catch(() => null) : null;
  return { status: res.status, ok: res.ok, json };
}

/** The refusal in a reply as the builder's `ApiProblem`; an answer that is not problem+json is an unreachable API (a proxy's error page). */
export function problemOf(reply: Reply): ApiProblem {
  if (reply.json === null || typeof reply.json !== 'object') throw new ApiUnreachable();
  const p = reply.json as { code?: unknown; detail?: unknown; title?: unknown };
  return new ApiProblem(reply.status, typeof p.code === 'string' ? p.code : 'UNKNOWN', typeof p.detail === 'string' ? p.detail : typeof p.title === 'string' ? p.title : '');
}

/** The body of a successful reply, read through `schema`; anything else is an unreachable API, as for every other call. */
function read<T>(reply: Reply, schema: z.ZodType<T>): T {
  if (!reply.ok) throw problemOf(reply);
  const parsed = schema.safeParse(reply.json);
  if (!parsed.success) throw new ApiUnreachable();
  return parsed.data;
}

function signedIn(): boolean {
  return useSessionStore.getState().status === 'signed_in';
}

/** An answer that means "nothing to use here" (not signed in, API down, 401, 404) is null; any other refusal is thrown. */
async function optional<T>(fn: () => Promise<T>): Promise<T | null> {
  if (!signedIn()) return null;
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiUnreachable) return null;
    if (err instanceof ApiProblem && (err.status === 401 || err.status === 404)) return null;
    throw err;
  }
}

const PAGE = 200;
const MAX_PAGES = 5;

/** Lists the active forms of `org`, following the cursor. Unreachable or signed-out sessions yield null. */
export function listRemoteForms(org: string): Promise<RemoteList | null> {
  return optional(async () => {
    const items: RemoteForm[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query: string = `limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = read(await orgCall(org, 'GET', `/v1/forms?${query}`), listSchema);
      items.push(...res.items.map((item) => ({ id: item.id, title: item.title, updatedAt: item.updatedAt })));
      cursor = res.nextCursor;
      if (!cursor) return { items, complete: true };
    }
    return { items, complete: false };
  });
}

/** The server's draft of a form, or null when there is none, the API is down or the session ended. */
export function getRemoteDraft(org: string, id: string): Promise<RemoteDraft | null> {
  return optional(async () => {
    const draft = read(await orgCall(org, 'GET', `/v1/forms/${encodeURIComponent(id)}/draft`), draftSchema);
    return { draftRev: draft.draftRev, schemaVersion: draft.schemaVersion, draft: draft.draft, updatedAt: draft.updatedAt, updatedBy: draft.updatedBy ?? null };
  });
}

/** Makes sure the form row exists in `org` (the first save of a form made here). A repeat changes nothing. */
export async function createRemoteForm(org: string, id: string, title: string): Promise<void> {
  read(await orgCall(org, 'POST', '/v1/forms', { id, title }), z.object({ id: z.string() }));
}

/**
 * Writes the v2 definition as the org draft if the server is still at `expectedRev` (`If-Match`; 0 for a form with no
 * draft yet). A 409 is a `DraftConflict` carrying the server's draft; nothing was written. Other refusals are
 * `ApiProblem`s, an unreachable API `ApiUnreachable`. Local FormOps (open/closed/password) are never sent.
 */
export async function putRemoteDraft(org: string, id: string, draft: unknown, expectedRev: number): Promise<{ draftRev: number; updatedAt: string }> {
  const reply = await orgCall(org, 'PUT', `/v1/forms/${encodeURIComponent(id)}/draft`, { draft }, { 'if-match': `"${expectedRev}"` });
  if (reply.status === 409) {
    const conflict = conflictSchema.safeParse(reply.json);
    if (conflict.success) {
      const { draftRev, draft: theirs, updatedAt, updatedBy } = conflict.data;
      throw new DraftConflict({ draftRev, draft: theirs, updatedAt, updatedBy: updatedBy ?? null });
    }
  }
  return read(reply, savedSchema);
}

/** Moves a form to the trash (restorable; nothing is deleted). A form the server never had is a 404, which the caller may ignore. */
export async function trashRemoteForm(org: string, id: string): Promise<void> {
  read(await orgCall(org, 'POST', `/v1/forms/${encodeURIComponent(id)}/trash`, {}), z.object({ id: z.string() }).passthrough());
}

const mergeConflictSchema = z.object({
  label: z.string(),
  type: z.string(),
  reason: z.string(),
  message: z.string(),
  sides: z.array(z.object({ formId: z.string(), formTitle: z.string(), blockId: z.string(), summary: z.string() })),
});

export type MergeRemoteResult = { ok: true; id: string } | { ok: false; conflicts: MergeConflict[] };

/** Asks the API to merge forms. Null when signed out or unreachable so the builder can merge locally. */
export async function mergeRemoteForms(
  formIds: string[],
  resolutions?: MergeResolution[],
  title?: string,
): Promise<MergeRemoteResult | null> {
  if (!signedIn()) return null;
  const session = useSessionStore.getState();
  const org = session.status === 'signed_in' ? activeOrgOf(session.me)?.id : null;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/forms/merge`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...CLIENT_HEADERS,
        ...(org ? { [ORG_HEADER]: org } : {}),
      },
      body: JSON.stringify({ formIds, resolutions, title }),
    });
  } catch {
    return null;
  }
  const json: unknown = await res.json().catch(() => ({}));
  if (res.status === 409) {
    const parsed = z.object({ status: z.literal('conflict'), conflicts: z.array(mergeConflictSchema) }).safeParse(json);
    if (parsed.success) return { ok: false, conflicts: parsed.data.conflicts };
  }
  if (res.status === 401 || res.status === 404) return null;
  if (!res.ok) {
    const p = json as { code?: unknown; detail?: unknown; title?: unknown };
    throw new ApiProblem(res.status, typeof p.code === 'string' ? p.code : 'UNKNOWN', typeof p.detail === 'string' ? p.detail : typeof p.title === 'string' ? p.title : '');
  }
  const id = z.object({ id: z.string() }).safeParse(json);
  return id.success ? { ok: true, id: id.data.id } : null;
}
