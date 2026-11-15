import { z } from 'zod';
import { compile } from '@form/logic';
import { REGISTRY } from '@form/registry';
import type { FormDefinition } from '@form/schema';
import { ApiUnreachable, activeOrgOf, loadSession } from '@/auth/client';
import { themeMediaForDraft } from '@/components/builder/design/uploads';
import { flushAutosave, raiseDraftConflict } from '@/persistence/autosave';
import { getRemoteDraft, orgCall, problemOf } from '@/persistence/draftsApi';
import { useUiStore } from '@/state/uiStore';

const liveSchema = z.object({
  slug: z.string(),
  versionId: z.string(),
  number: z.number(),
  /** The draft revision the version froze; null for a version published before revisions were recorded. */
  draftRev: z.number().nullable().optional(),
});

export type LiveForm = z.infer<typeof liveSchema>;

/** One problem the server found in a draft (`POST /v1/forms/:id/validate`, or a refused publish): where it is and what to do. */
const issueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  /** A JSON pointer into the definition, e.g. `/blocks/<id>/config/pattern`. */
  path: z.string(),
  message: z.string(),
  fixUrl: z.string().optional(),
});
export type PublishIssueView = z.infer<typeof issueSchema>;

const checkSchema = z.object({
  ok: z.boolean(),
  draftRev: z.number(),
  definitionHash: z.string().nullable(),
  issues: z.array(issueSchema),
  issueCount: z.number(),
});
export type PublishCheck = z.infer<typeof checkSchema>;

const refusalSchema = z.object({ code: z.string(), detail: z.string().optional(), issues: z.array(issueSchema).optional(), issueCount: z.number().optional() });

/** Publishing is for signed-in members of an org: the builder sends everyone else to sign in (the draft stays in the org's cache). */
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

/**
 * The server refused to publish (422): `PUBLISH_BLOCKED` with the issues to fix, or `PLAN_MISMATCH` (the plan this
 * browser compiled is not the one the server compiles from the saved draft; no issues, only a detail). Nothing was published.
 */
export class PublishBlocked extends Error {
  readonly code: 'PUBLISH_BLOCKED' | 'PLAN_MISMATCH';
  readonly issues: PublishIssueView[];
  /** How many issues there were before the server cut the list. */
  readonly issueCount: number;
  constructor(code: 'PUBLISH_BLOCKED' | 'PLAN_MISMATCH', detail: string, issues: PublishIssueView[], issueCount = issues.length) {
    super(detail);
    this.name = 'PublishBlocked';
    this.code = code;
    this.issues = issues;
    this.issueCount = issueCount;
  }
}

/** The server's draft moved on between the save and the publish (409): the merge dialog is open, nothing was published. */
export class PublishConflict extends Error {
  constructor() {
    super('This form changed somewhere else. Choose which version to keep, then publish again.');
    this.name = 'PublishConflict';
  }
}

/**
 * The latest changes are not on the server, so a publish would freeze an older draft than the one on screen: the
 * author is offline, has a merge to resolve (`conflict`: the dialog is open already), or a save was refused.
 */
export class DraftNotSaved extends Error {
  readonly conflict: boolean;
  constructor(conflict: boolean) {
    super('Your latest changes are not saved to the server yet, so this form cannot be published. Check the save status, then try again.');
    this.name = 'DraftNotSaved';
    this.conflict = conflict;
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

/** The active org of a fresh look at the session: a session may have ended since the page loaded. */
async function orgNow(): Promise<string> {
  const session = await loadSession();
  if (session.status === 'unreachable') throw new ApiUnreachable();
  if (session.status !== 'signed_in') throw new SignInRequired();
  const org = activeOrgOf(session.me);
  if (!org) throw new OrgRequired();
  return org.id;
}

/** Writes what is on screen to the server (and this browser), and answers the draft revision that holds exactly it. */
async function savedRevision(): Promise<number> {
  const { serverRev } = await flushAutosave();
  if (serverRev === null || serverRev < 1) throw new DraftNotSaved(useUiStore.getState().draftConflict !== null);
  return serverRev;
}

/**
 * The issues that would block publishing the saved draft, with nothing published (`POST /v1/forms/:id/validate`).
 * The open document is saved first, so the answer is about what is on screen.
 */
export async function checkPublishable(id: string): Promise<PublishCheck> {
  const org = await orgNow();
  await savedRevision();
  const reply = await orgCall(org, 'POST', `/v1/forms/${encodeURIComponent(id)}/validate`, {});
  if (!reply.ok) throw problemOf(reply);
  const parsed = checkSchema.safeParse(reply.json);
  if (!parsed.success) throw new ApiUnreachable();
  return parsed.data;
}

/** The hash of the plan this browser compiles from the draft: what the server's own compile has to equal. */
function planHash(doc: FormDefinition): string {
  const built = compile(doc, REGISTRY);
  if (!built.ok) throw new PublishBlocked('PUBLISH_BLOCKED', 'This form cannot be compiled yet.', built.issues.map((i) => ({ severity: i.severity, code: i.code, path: i.path, message: i.message, ...(i.fixUrl ? { fixUrl: i.fixUrl } : {}) })));
  return built.compiled.definitionHash;
}

/**
 * Freezes the draft as a public fill link: `POST /v1/forms/:id/publish` (session cookie, `X-FR-Org`, `forms.publish`)
 * after the open document is saved. The request names the draft revision the author is publishing (`expectedDraftRev`: a
 * newer draft is a 409 and opens the merge dialog, a revision that was already published returns its version) and the
 * hash of the plan this browser compiled, which the server compares with its own compile (a tampered or stale plan is a
 * 422). There is no anonymous publish: without a session this throws `SignInRequired`, and without an org `OrgRequired`.
 */
export async function publishLive(id: string, doc: FormDefinition): Promise<LiveForm> {
  const org = await orgNow();
  const expectedDraftRev = await savedRevision();
  const clientDefinitionHash = planHash(doc);
  const media = themeMediaForDraft(doc);
  const reply = await orgCall(org, 'POST', `/v1/forms/${encodeURIComponent(id)}/publish`, {
    expectedDraftRev,
    clientDefinitionHash,
    ...(Object.keys(media).length ? { media } : {}),
  });

  if (reply.status === 409) {
    const server = await getRemoteDraft(org, id).catch(() => null);
    if (server) raiseDraftConflict(server);
    throw new PublishConflict();
  }
  if (reply.status === 422) {
    const refusal = refusalSchema.safeParse(reply.json);
    if (refusal.success && (refusal.data.code === 'PUBLISH_BLOCKED' || refusal.data.code === 'PLAN_MISMATCH')) {
      const issues = refusal.data.issues ?? [];
      throw new PublishBlocked(refusal.data.code, refusal.data.detail ?? '', issues, refusal.data.issueCount ?? issues.length);
    }
  }
  if (!reply.ok) throw problemOf(reply);
  const live = liveSchema.safeParse(reply.json);
  if (!live.success) throw new ApiUnreachable();
  rememberSlug(id, live.data.slug);
  return live.data;
}
