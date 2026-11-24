import { z } from 'zod';

/*
 * The launch descriptor (DESIGN section 2): DMS opens fORM- at `<FP>/embed/<mode>#fp=<base64url(JSON)>`. It carries no
 * authority: every read and write goes to dms-api with the user's own DMS token, which enforces permissions. Two
 * fields are dangerous and are checked against allowlists here: `returnUrl` (open redirect) and `apiBase` (the DMS
 * token is only ever sent to an allowlisted `apiBase`).
 */

export const LAUNCH_MODES = ['dms-master', 'dms-upload', 'dms-record'] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];
export type ProfileName = 'full' | 'dms-v1';

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
      classification: z.string().max(100).nullable().optional(),
    })
    .optional(),
  returnUrl: z.string().max(2048),
  apiBase: z.string().max(2048),
});
export type LaunchDescriptor = z.infer<typeof LaunchDescriptorSchema>;

/** A descriptor that passed every check, with the two URLs normalised. `returnUrl` is null when it is not on the allowlist. */
export interface ResolvedLaunch extends Omit<LaunchDescriptor, 'returnUrl' | 'apiBase'> {
  /** dms-api base, absolute, no trailing slash. */
  apiBase: string;
  returnUrl: string | null;
}

export interface LaunchEnv {
  /** This page's origin. */
  origin: string;
  /** `VITE_FP_RETURN_ORIGINS`: origins `returnUrl` may point at, besides this page's own. */
  returnOrigins: readonly string[];
  /** `VITE_FP_DMS_API_ORIGINS`: origins `apiBase` may point at, besides this page's own. */
  apiOrigins: readonly string[];
  /** `VITE_FP_DEV_OVERRIDES=1`: honours `?fp_profile=`. Dead code in a production build. */
  devOverrides: boolean;
}

const originList = (raw: unknown): string[] =>
  typeof raw === 'string'
    ? raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)
    : [];

export function launchEnv(): LaunchEnv {
  const env = import.meta.env as Record<string, string | undefined>;
  return {
    origin: globalThis.location?.origin ?? '',
    returnOrigins: originList(env.VITE_FP_RETURN_ORIGINS),
    apiOrigins: originList(env.VITE_FP_DMS_API_ORIGINS),
    devOverrides: env.VITE_FP_DEV_OVERRIDES === '1',
  };
}

export type LaunchFailure = 'missing' | 'malformed' | 'invalid' | 'wrong_mode' | 'api_origin_rejected';
export type LaunchResult = { ok: true; launch: ResolvedLaunch } | { ok: false; reason: LaunchFailure; detail?: string };

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** `base64url(JSON)` as the descriptor travels; throws on anything else. Exported for the DMS side's tests and the encoder below. */
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

/** The `fp` value of a `#fp=...` fragment, or null. */
export function fragmentValue(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  return params.get('fp');
}

/** An http(s) URL with no credentials, or null. With `relativeOk`, a root-relative path resolves against `origin` (dev rewrite on the DMS host). */
function absoluteUrl(raw: string, origin: string, relativeOk: boolean): URL | null {
  try {
    if (relativeOk && /^\/(?!\/)/.test(raw)) raw = new URL(raw, origin).toString();
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return url;
  } catch {
    return null;
  }
}

const allowed = (url: URL, env: LaunchEnv, extra: readonly string[]): boolean => url.origin === env.origin || extra.includes(url.origin);

/** Validates a decoded descriptor for the route `mode`. */
export function validateDescriptor(raw: unknown, mode: LaunchMode, env: LaunchEnv): LaunchResult {
  const parsed = LaunchDescriptorSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid', detail: parsed.error.issues[0]?.message ?? 'invalid descriptor' };
  const d = parsed.data;
  if (d.mode !== mode) return { ok: false, reason: 'wrong_mode', detail: `${d.mode} on the ${mode} route` };
  const api = absoluteUrl(d.apiBase, env.origin, true);
  if (!api || !allowed(api, env, env.apiOrigins)) return { ok: false, reason: 'api_origin_rejected', detail: api?.origin ?? d.apiBase };
  const back = absoluteUrl(d.returnUrl, env.origin, false);
  const { returnUrl: _r, apiBase: _a, ...rest } = d;
  return {
    ok: true,
    launch: {
      ...rest,
      apiBase: `${api.origin}${api.pathname}`.replace(/\/+$/, ''),
      returnUrl: back && allowed(back, env, env.returnOrigins) ? back.toString() : null,
    },
  };
}

/** Resolves the descriptor from a `#fp=` fragment. */
export function parseLaunch(hash: string, mode: LaunchMode, env: LaunchEnv): LaunchResult {
  const encoded = fragmentValue(hash);
  if (encoded === null) return { ok: false, reason: 'missing' };
  let raw: unknown;
  try {
    raw = decodeDescriptor(encoded);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  return validateDescriptor(raw, mode, env);
}

/** `returnUrl` with the outcome appended, as DMS reads it (`fp_status`, `fp_master_id`). */
export function returnTarget(returnUrl: string, status: 'saved' | 'cancelled', masterId?: string): string {
  const url = new URL(returnUrl);
  url.searchParams.set('fp_status', status);
  if (masterId) url.searchParams.set('fp_master_id', masterId);
  return url.toString();
}

/* ── remembering the descriptor for this tab ─────────────────────────────────────────────────────────────────── */

const storeKey = (mode: LaunchMode) => `fp.launch.${mode}`;
const memo = new Map<LaunchMode, ResolvedLaunch>();

/** For tests. */
export function resetLaunchMemo(): void {
  memo.clear();
  try {
    globalThis.sessionStorage?.clear();
  } catch {
    /* no storage */
  }
}

/**
 * The launch of this page view. The fragment is parsed once and then removed from the address bar (it never reaches a
 * server log, and a copied URL no longer carries it); the validated result is kept for this tab so a reload or a
 * StrictMode remount does not lose it. The kept copy is re-validated on read: it is the same untrusted shape.
 */
export function currentLaunch(mode: LaunchMode, env: LaunchEnv = launchEnv(), loc: Pick<Location, 'hash' | 'pathname' | 'search'> = globalThis.location): LaunchResult {
  const fragment = fragmentValue(loc.hash);
  if (fragment !== null) {
    const result = parseLaunch(loc.hash, mode, env);
    try {
      globalThis.history?.replaceState(globalThis.history.state, '', `${loc.pathname}${loc.search}`);
    } catch {
      /* a sandboxed frame */
    }
    if (result.ok) {
      memo.set(mode, result.launch);
      try {
        globalThis.sessionStorage?.setItem(storeKey(mode), fragment);
      } catch {
        /* no storage: a reload will ask DMS again */
      }
    }
    return result;
  }
  const kept = memo.get(mode);
  if (kept) return { ok: true, launch: kept };
  try {
    const stored = globalThis.sessionStorage?.getItem(storeKey(mode));
    if (stored) {
      const result = parseLaunch(`#fp=${stored}`, mode, env);
      if (result.ok) memo.set(mode, result.launch);
      return result;
    }
  } catch {
    /* no storage */
  }
  return { ok: false, reason: 'missing' };
}

/**
 * After DMS accepted a create (POST), this tab's launch becomes "edit master `masterId`": the kept copy and the stored
 * descriptor both carry the new id, so a reload opens that master instead of creating (and being refused) again. The
 * stored descriptor is rewritten from its own validated content; nothing else about it changes.
 */
export function rememberMasterId(mode: LaunchMode, masterId: string): void {
  const kept = memo.get(mode);
  if (kept) memo.set(mode, { ...kept, masterId });
  try {
    const stored = globalThis.sessionStorage?.getItem(storeKey(mode));
    if (!stored) return;
    const raw = decodeDescriptor(stored) as Record<string, unknown>;
    globalThis.sessionStorage?.setItem(storeKey(mode), encodeDescriptor({ ...(raw as unknown as LaunchDescriptor), masterId }));
  } catch {
    /* no storage, or a stored copy that no longer decodes: a reload shows the launch problem screen, never a second POST */
    try {
      globalThis.sessionStorage?.removeItem(storeKey(mode));
    } catch {
      /* no storage */
    }
  }
}

/** `?fp_profile=dms-v1|full`: the dev override of the normal builder's profile; null unless the build allows it. */
export function profileOverride(search: string, env: LaunchEnv = launchEnv()): ProfileName | null {
  if (!env.devOverrides) return null;
  const v = new URLSearchParams(search).get('fp_profile');
  return v === 'dms-v1' || v === 'full' ? v : null;
}
