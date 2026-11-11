import { z } from 'zod';
import { ApiProblem, ApiUnreachable, orgApi, useSessionStore } from '@/auth/client';

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

function signedIn(): boolean {
  return useSessionStore.getState().status === 'signed_in';
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
