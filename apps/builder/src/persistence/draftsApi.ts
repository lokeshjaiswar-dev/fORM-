import { z } from 'zod';
import type { MergeConflict, MergeResolution } from '@form/schema';
import { ApiProblem, ApiUnreachable, CLIENT_HEADERS, DEV_USER_HEADERS, OPEN_ORG_ID, ORG_HEADER, orgApi } from '@/auth/client';
import { API_BASE } from '@/edition/edition';

const created = z.object({ id: z.string() });
const listSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      lifecycle: z.string(),
      updatedAt: z.string(),
    }),
  ),
});
const draftSchema = z.object({
  draftRev: z.number(),
  schemaVersion: z.number(),
  draft: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
});
const savedSchema = z.object({ draftRev: z.number(), updatedAt: z.string() });

export type RemoteForm = { id: string; title: string; updatedAt: string };
export type RemoteDraft = { draftRev: number; schemaVersion: number; draft: Record<string, unknown>; updatedAt: string };

/** No-login mode: the builder always talks to the API as the demo user (see OPEN_ORG_ID in auth/client). */
function signedIn(): boolean {
  return true;
}

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

/** Lists form rows in the active org. Unreachable or signed-out sessions yield null. */
export function listRemoteForms(): Promise<RemoteForm[] | null> {
  return optional(async () => {
    const res = await orgApi('GET', '/v1/forms', listSchema);
    return res.items.map((item) => ({ id: item.id, title: item.title, updatedAt: item.updatedAt }));
  });
}

export function getRemoteDraft(id: string): Promise<RemoteDraft | null> {
  return optional(() => orgApi('GET', `/v1/forms/${id}/draft`, draftSchema));
}

async function writeDraft(id: string, draft: unknown, title: string): Promise<void> {
  await orgApi('POST', '/v1/forms', created, { id, title });
  await orgApi('PUT', `/v1/forms/${id}/draft`, savedSchema, { draft });
}

/**
 * Ensures the form row exists, then writes the v2 definition. Local FormOps (open/closed/password) are not sent.
 * Offline or unsigned-in: no-op. Other API refusals surface so autosave can retry.
 */
export async function putRemoteDraft(id: string, draft: unknown, title: string): Promise<void> {
  try {
    await writeDraft(id, draft, title);
  } catch (err) {
    if (err instanceof ApiUnreachable) return;
    if (err instanceof ApiProblem) return;
    throw err;
  }
}

/** Same write as autosave, but refusals are not swallowed — used by Publish. */
export function putRemoteDraftForPublish(id: string, draft: unknown, title: string): Promise<void> {
  return writeDraft(id, draft, title);
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
  const org = OPEN_ORG_ID;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/forms/merge`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...DEV_USER_HEADERS,
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
