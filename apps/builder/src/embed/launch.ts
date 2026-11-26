import { RETURN_CODE_RE, RETURN_ID_RE, type ErrorCode, type SessionContext } from '@/embed/contract';
import { readHandoffEnv } from '@/embed/session/env';
import { allowedUrl, clearHandoffStorage, type HandoffEnv } from '@/embed/session/handoff';
import { LAUNCH_MODES, type LaunchDescriptor, type LaunchMode, type ProfileName, type ResolvedLaunch } from '@/embed/session/launchTypes';
import { legacyLaunchOf, legacyMasterIdHook, resetLegacySlot } from '@/embed/session/legacySlot';
import { resetSessionForTests, sessionApiBase, sessionContext, setContextMasterId } from '@/embed/session/dmsSession';

/*
 * What a page learns about its launch (DESIGN 3.2, 5.1). Since run dmsplus-int the launch is not a link the page parses: DMS hands
 * over a one-use ticket in `#fpt=`, `session/SessionGate` exchanges it for a short-lived credential and a context, and
 * `currentLaunch(mode)` builds the `ResolvedLaunch` from that context. The pages keep calling `currentLaunch` and `createDmsClient`
 * exactly as before; nothing in the link carries authority (tenant, workspace, master, API base all come from dms-api or the build).
 *
 * The old `#fp=` descriptor is parsed in `embed/legacy/descriptor.ts`, reachable only in the M2 build (VITE_FP_LEGACY_DESCRIPTOR=1).
 */

export { LAUNCH_MODES };
export type { LaunchDescriptor, LaunchMode, ProfileName, ResolvedLaunch };

export interface LaunchEnv {
  /** This page's origin. */
  origin: string;
  /** `VITE_FP_RETURN_ORIGINS`: origins `returnUrl` may point at, besides this page's own. */
  returnOrigins: readonly string[];
  /** `VITE_FP_DMS_API_BASE`: the exact DMS API bases (origin and path). The session credential is only ever sent to one of them. */
  apiBases: readonly string[];
  /** `VITE_FP_DEV_OVERRIDES=1`: honours `?fp_profile=` and `&fpv=`. Dead code in a production build. */
  devOverrides: boolean;
  /** `VITE_FP_LEGACY_DESCRIPTOR=1` (the M2 build). */
  legacyDescriptor?: boolean;
}

export const launchEnv = (): LaunchEnv => readHandoffEnv();

const handoffEnvOf = (env: LaunchEnv): HandoffEnv => ({ ...env, legacyDescriptor: env.legacyDescriptor === true });

export type LaunchFailure = 'missing' | 'malformed' | 'invalid' | 'wrong_mode' | 'api_origin_rejected';
export type LaunchResult = { ok: true; launch: ResolvedLaunch } | { ok: false; reason: LaunchFailure; detail?: string };

/* ── the legacy descriptor codec (base64url JSON) ─────────────────────────────────────────────────────────────── */

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** `base64url(JSON)` as the old descriptor travelled; throws on anything else. Only the M2 build parses one (`embed/legacy`); tests of DMS-side code encode with it. */
export function decodeDescriptor(encoded: string): unknown {
  if (!B64URL.test(encoded) || encoded.length > 16_384) throw new Error('not base64url');
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function encodeDescriptor(descriptor: LaunchDescriptor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(descriptor));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ── the return link ──────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * `returnUrl` with the outcome appended, as DMS reads it (contract `formplus-return`, DESIGN 3.5): `fp_status` = saved | cancelled |
 * error, `fp_master_id`, and `fp_code` only with `error` (a code from the error table, `^[A-Z_]{1,64}$`). A value that does not match
 * its pattern is left out rather than sent.
 */
export function returnTarget(returnUrl: string, status: 'saved' | 'cancelled' | 'error', masterId?: string, code?: ErrorCode | string): string {
  const url = new URL(returnUrl);
  url.searchParams.set('fp_status', status);
  if (masterId && RETURN_ID_RE.test(masterId)) url.searchParams.set('fp_master_id', masterId);
  if (status === 'error' && code && RETURN_CODE_RE.test(code)) url.searchParams.set('fp_code', code);
  return url.toString();
}

/* ── the launch of this page view ─────────────────────────────────────────────────────────────────────────────── */

/** For tests: forget the session, the resume hint, the legacy launch and the memo of the launch flow. */
export function resetLaunchMemo(): void {
  resetSessionForTests();
  resetLegacySlot();
  clearHandoffStorage();
}

const built = new WeakMap<SessionContext, { returnKey: string | null; apiBase: string; launch: ResolvedLaunch }>();

function fromContext(context: SessionContext, apiBase: string, env: LaunchEnv): ResolvedLaunch {
  const returnUrl = allowedUrl(context.return_url, env);
  const kept = built.get(context);
  if (kept && kept.returnKey === returnUrl && kept.apiBase === apiBase) return kept.launch;
  const seed = context.master_seed;
  const launch: ResolvedLaunch = {
    v: 1,
    mode: context.mode,
    profile: 'dms-v1',
    // Display values: fORM- never sends them, dms-api knows them from the session.
    tenantId: context.tenant_id,
    workspaceId: context.workspace_id,
    ...(context.master_id !== null ? { masterId: context.master_id } : {}),
    ...(context.record_id !== null ? { recordId: context.record_id } : {}),
    ...(seed !== null ? { master: { name: seed.name, doctypeIds: [...seed.doctype_ids], folderIds: [...seed.folder_ids], classification: seed.classification } } : {}),
    apiBase,
    returnUrl,
  };
  built.set(context, { returnKey: returnUrl, apiBase, launch });
  return launch;
}

/**
 * The launch of this page view for `mode`: built from the context the exchange returned, or (the M2 legacy build) from the `#fp=`
 * descriptor `embed/legacy` validated. `missing` until `SessionGate` has finished the launch; the pages are only rendered after it.
 * `loc` is accepted for the old call shape and is not used.
 */
export function currentLaunch(mode: LaunchMode, env: LaunchEnv = launchEnv(), _loc?: Pick<Location, 'hash' | 'pathname' | 'search'>): LaunchResult {
  const context = sessionContext();
  const apiBase = sessionApiBase();
  if (context !== null && apiBase !== null && context.mode === mode) return { ok: true, launch: fromContext(context, apiBase, env) };
  const legacy = legacyLaunchOf(mode);
  if (legacy) return { ok: true, launch: legacy };
  return { ok: false, reason: 'missing' };
}

/**
 * After DMS accepted a create (POST), this page's launch becomes "edit master `masterId`": a reconnect asks for an edit ticket and
 * its context is compared against this, and a reload resumes into that master instead of creating (and being refused) again.
 */
export function rememberMasterId(mode: LaunchMode, masterId: string): void {
  const context = sessionContext();
  if (context !== null && context.mode === mode) return setContextMasterId(masterId, handoffEnvOf(launchEnv()));
  legacyMasterIdHook()?.(mode, masterId);
}

/** `?fp_profile=dms-v1|full`: the dev override of the normal builder's profile; null unless the build allows it. */
export function profileOverride(search: string, env: LaunchEnv = launchEnv()): ProfileName | null {
  if (!env.devOverrides) return null;
  const v = new URLSearchParams(search).get('fp_profile');
  return v === 'dms-v1' || v === 'full' ? v : null;
}
