import { z } from 'zod';
import { api } from '@/auth/client';
import { themeMediaForDraft } from '@/components/builder/design/uploads';
import { currentOps } from '@/state/opsStore';

const liveSchema = z.object({
  slug: z.string(),
  versionId: z.string(),
  number: z.number(),
});

export type LiveForm = z.infer<typeof liveSchema>;

const LIVE_KEY = (id: string) => `fr.live.${id}`;

export function rememberedSlug(id: string): string | null {
  try {
    return globalThis.localStorage?.getItem(LIVE_KEY(id)) ?? null;
  } catch {
    return null;
  }
}

function rememberSlug(id: string, slug: string): void {
  try {
    globalThis.localStorage?.setItem(LIVE_KEY(id), slug);
  } catch {
    /* Private browsing. */
  }
}

export function fillUrl(slug: string): string {
  return `${window.location.origin}/f/${encodeURIComponent(slug)}`;
}

/**
 * Freezes the current draft as a public fill link. Does not send X-FR-Org; nobody needs to be signed in.
 */
export async function publishLive(id: string, draft: unknown, _title: string): Promise<LiveForm> {
  const media = themeMediaForDraft(draft);
  const withMedia = draft && typeof draft === 'object' ? { ...(draft as Record<string, unknown>), media } : draft;
  const live = await api('POST', '/v1/p/publish', liveSchema, { id, draft: withMedia, media, submissionApi: currentOps().submissionApi });
  rememberSlug(id, live.slug);
  return live;
}
