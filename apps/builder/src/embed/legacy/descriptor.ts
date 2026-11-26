import { z } from 'zod';
import { decodeDescriptor, encodeDescriptor } from '@/embed/launch';
import { allowedUrl, forgetLegacyFragment, recallLegacyFragment, rememberLegacyFragment, type HandoffEnv } from '@/embed/session/handoff';
import { LAUNCH_MODES, type LaunchDescriptor, type LaunchMode, type LegacyOutcome, type ResolvedLaunch } from '@/embed/session/launchTypes';
import { installLegacy, legacyLaunchOf, updateLegacyLaunch } from '@/embed/session/legacySlot';
import { absoluteUrl, normalBase } from '@/embed/session/env';
import { createLegacyClient } from './client';

/*
 * The launch descriptor of the M2 legacy build (DESIGN section 2 of the pre-run design): DMS opened fORM- at
 * `<FP>/embed/<mode>#fp=<base64url(JSON)>`. It carries no authority beyond what the user's own DMS token has: every read and write goes to
 * dms-api with that token. Two fields are dangerous and checked against allowlists: `returnUrl` (open redirect) and `apiBase` (the token
 * is only ever sent to a configured base, matched exactly, path included).
 *
 * Reached only by a dynamic import behind VITE_FP_LEGACY_DESCRIPTOR=1 (`session/launchFlow.ts`). A default build does not contain it and
 * refuses `#fp=` ("This link is no longer supported. Open the form again from DMS.").
 */

const ident = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'unexpected characters in an id');
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'not a uuid');

export const LaunchDescriptorSchema = z.strictObject({
  v: z.literal(1),
  mode: z.enum(LAUNCH_MODES),
  profile: z.literal('dms-v1'),
  tenantId: ident,
  workspaceId: ident,
  masterId: uuid.optional(),
  recordId: ident.optional(),
  slug: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  master: z
    .strictObject({
      name: z.string().max(255),
      doctypeIds: z.array(uuid).max(500),
      folderIds: z.array(uuid).max(500),
      /* dms-ui always sends the key (null). Only null is accepted: the create POST hard-codes null, so a link never chooses it. */
      classification: z.null().optional(),
    })
    .optional(),
  returnUrl: z.string().max(2048),
  apiBase: z.string().max(2048),
});

export type LegacyLaunchFailure = 'invalid' | 'wrong_mode' | 'api_origin_rejected';
export type LegacyResult = { ok: true; launch: ResolvedLaunch } | { ok: false; reason: LegacyLaunchFailure; detail?: string };

/** Validates a decoded descriptor for the route `mode`. */
export function validateDescriptor(raw: unknown, mode: LaunchMode, env: Pick<HandoffEnv, 'origin' | 'returnOrigins' | 'apiBases'>): LegacyResult {
  const parsed = LaunchDescriptorSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid', detail: parsed.error.issues[0]?.message ?? 'invalid descriptor' };
  const d = parsed.data;
  if (d.mode !== mode) return { ok: false, reason: 'wrong_mode', detail: `${d.mode} on the ${mode} route` };
  const api = absoluteUrl(d.apiBase, env.origin);
  if (!api || api.search !== '' || api.hash !== '' || !env.apiBases.includes(normalBase(api))) return { ok: false, reason: 'api_origin_rejected', detail: api ? normalBase(api) : d.apiBase };
  const { returnUrl, apiBase: _api, ...rest } = d;
  return { ok: true, launch: { ...rest, apiBase: normalBase(api), returnUrl: allowedUrl(returnUrl, env) } };
}

/** A create gave the master an id: the kept launch and the stored descriptor both say "edit that master", so a reload does not create twice. */
function onMasterId(mode: LaunchMode, masterId: string): void {
  const kept = legacyLaunchOf(mode);
  if (kept) updateLegacyLaunch(mode, { ...kept, masterId });
  try {
    const stored = recallLegacyFragment(mode);
    if (!stored) return;
    const raw = decodeDescriptor(stored) as unknown as LaunchDescriptor;
    rememberLegacyFragment(mode, encodeDescriptor({ ...raw, masterId }));
  } catch {
    // A stored copy that no longer decodes: a reload shows the launch problem screen, never a second POST.
    forgetLegacyFragment(mode);
  }
}

/** Accepts a `#fp=` launch: validates it, installs the legacy transport, and keeps the descriptor for a reload in this tab. */
export function startFromFragment(mode: LaunchMode, fragment: string, env: HandoffEnv, remember = true): LegacyOutcome {
  let raw: unknown;
  try {
    raw = decodeDescriptor(fragment);
  } catch {
    return { kind: 'failed', reason: 'malformed' };
  }
  const result = validateDescriptor(raw, mode, env);
  if (!result.ok) return { kind: 'failed', reason: result.reason === 'api_origin_rejected' ? 'api_not_allowed' : result.reason };
  const launch: ResolvedLaunch = result.launch;
  installLegacy({
    launch,
    client: (options) => createLegacyClient({ ...options, apiBase: launch.apiBase, tenantId: launch.tenantId, workspaceId: launch.workspaceId }),
    onMasterId,
  });
  if (remember) rememberLegacyFragment(mode, fragment);
  return { kind: 'legacy' };
}

/** A reload of a legacy launch: the descriptor kept for this tab, validated again (storage is untrusted too). */
export function resumeFromStorage(mode: LaunchMode, env: HandoffEnv): LegacyOutcome | null {
  const stored = recallLegacyFragment(mode);
  return stored === null ? null : startFromFragment(mode, stored, env, false);
}
