import { z } from 'zod';
import { ApiUnreachable, activeOrgOf, loadSession, orgApi } from '@/auth/client';
import { themeMediaForDraft } from '@/components/builder/design/uploads';
import { putRemoteDraftForPublish } from '@/persistence/draftsApi';

const liveSchema = z.object({
  slug: z.string(),
  versionId: z.string(),
  number: z.number(),
});

export type LiveForm = z.infer<typeof liveSchema>;

/** Publishing is for signed-in members of an org: the builder sends everyone else to sign in (the draft stays here). */
export class SignInRequired extends Error {
  constructor() {
    super('Sign in to publish this form.');
    this.name = 'SignInRequired';
  }
}

/** Signed in, but a member of no org yet: a form is published into an org, so the first one is created first. */
export class OrgRequired extends Error {
  constructor() {
    super('Create an organisation to publish this form into.');
    this.name = 'OrgRequired';
  }
}

const LIVE_KEY = (id: string) => `fr.live.${id}`;

export function rememberedSlug(id: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(LIVE_KEY(id)) ?? null;
  } catch {
    return null;
  }
}

function rememberSlug(id: string, slug: string): void {
  try {
    globalThis.sessionStorage?.setItem(LIVE_KEY(id), slug);
  } catch {
    /* Private browsing. */
  }
}

export function fillUrl(slug: string): string {
  return `${window.location.origin}/f/${encodeURIComponent(slug)}`;
}

/**
 * Freezes the draft as a public fill link: the draft is saved to the active org, then `POST /v1/forms/:id/publish`
 * publishes it (session cookie, `X-FR-Org`, `forms.publish`). There is no anonymous publish: without a session this
 * throws `SignInRequired`, and without an org `OrgRequired`.
 */
export async function publishLive(id: string, draft: unknown, title: string): Promise<LiveForm> {
  // Asked afresh: a session may have ended since the page loaded.
  const session = await loadSession();
  if (session.status === 'unreachable') throw new ApiUnreachable();
  if (session.status !== 'signed_in') throw new SignInRequired();
  if (!activeOrgOf(session.me)) throw new OrgRequired();
  await putRemoteDraftForPublish(id, draft, title);
  const media = themeMediaForDraft(draft);
  const live = await orgApi('POST', `/v1/forms/${encodeURIComponent(id)}/publish`, liveSchema, Object.keys(media).length ? { media } : {});
  rememberSlug(id, live.slug);
  return live;
}
