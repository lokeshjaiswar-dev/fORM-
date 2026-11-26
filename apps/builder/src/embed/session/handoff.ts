import { TICKET_MODES, checkLaunchUrl, parseTicketFragment, type TicketMode } from '@/embed/contract';

/*
 * The hand-off from the DMS page to this page (SEC-DESIGN 1.3, 1.7, 1.9, DESIGN 3.2). The ONLY module of fORM- that touches
 * `sessionStorage` (scripts/lint-embed-authority.mjs enforces it, T-DMSINT-53). Three keys:
 *
 *   fp.lv      the PKCE verifier the DMS page stored right before `location.assign`. Read once, then removed.
 *   fp.resume  a NON-secret hint `{mode, master_id, record_id, reconnect_url, return_url}` written after a launch, so a reload
 *              can offer "Reconnect" instead of a dead page. It holds no credential, ticket or verifier, and is re-validated on read.
 *   fp.launch.<mode>  legacy build only (VITE_FP_LEGACY_DESCRIPTOR=1, M2): the `#fp=` descriptor kept for a reload, as before.
 *
 * Nothing here makes a request, and the fragment is removed from the address bar before anything else happens.
 */

const VERIFIER_KEY = 'fp.lv';
const RESUME_KEY = 'fp.resume';
const legacyKey = (mode: string) => `fp.launch.${mode}`;

/** What the hand-off needs to know about this build and page. Built by `launch.ts` (`launchEnv`), injected so tests can vary it. */
export interface HandoffEnv {
  /** This page's origin. */
  origin: string;
  /** `VITE_FP_RETURN_ORIGINS`: origins a return or reconnect URL may point at, besides this page's own. */
  returnOrigins: readonly string[];
  /** `VITE_FP_DMS_API_BASE`: the exact absolute DMS API bases (no trailing slash). The credential only ever goes to one of them. */
  apiBases: readonly string[];
  /** `VITE_FP_DEV_OVERRIDES=1`: honours `&fpv=<verifier>`. Dead code in a production build. */
  devOverrides: boolean;
  /** `VITE_FP_LEGACY_DESCRIPTOR=1` (M2 build): a `#fp=` descriptor is handed to `embed/legacy` instead of being refused. */
  legacyDescriptor: boolean;
}

export type HandoffFailure = 'missing' | 'legacy_descriptor' | 'malformed' | 'api_not_allowed' | 'no_verifier';

/** The non-secret hint a reload uses (SEC 1.7). */
export interface ResumeHint {
  mode: TicketMode;
  master_id: string | null;
  record_id: string | null;
  reconnect_url: string;
  return_url: string;
}

export type Handoff =
  /** A ticket and the verifier that goes with it; `apiBase` is the one allowlisted base the exchange goes to. */
  | { kind: 'ticket'; ticket: string; verifier: string; apiBase: string }
  /** A `#fp=` link in a build that still accepts it (M2): `fragment` is the raw descriptor value. */
  | { kind: 'legacy'; fragment: string }
  /** No fragment, but a previous launch left a hint: "Session ended" and a Reconnect button, no request. */
  | { kind: 'resume'; hint: ResumeHint }
  | { kind: 'failed'; reason: HandoffFailure };

/** `sessionStorage` or null: a sandboxed frame, a blocked-storage browser or a private window may throw. */
function store(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Removes the fragment from the address bar. Called before any request, and also for a fragment that is refused. */
function stripFragment(loc: Pick<Location, 'pathname' | 'search'>): void {
  try {
    globalThis.history?.replaceState(globalThis.history.state, '', `${loc.pathname}${loc.search}`);
  } catch {
    /* a sandboxed frame */
  }
}

/** Reads `fp.lv` and removes it in the same step: a verifier is used once. */
function takeVerifier(): string | null {
  const s = store();
  if (!s) return null;
  try {
    const v = s.getItem(VERIFIER_KEY);
    s.removeItem(VERIFIER_KEY);
    return v;
  } catch {
    return null;
  }
}

const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;

/**
 * Reads this page view's launch from the address bar and tab storage, in this order:
 *  1. strip the fragment from the address bar (before anything can fail or send);
 *  2. a `#fpt=` ticket: with the verifier from `fp.lv` (or `&fpv` in a dev build) and an allowlisted API base;
 *  3. a `#fp=` descriptor: refused ("no longer supported") unless this is the M2 legacy build;
 *  4. no fragment: the `fp.resume` hint of an earlier launch in this tab, else `missing`.
 * A ticket without a verifier is refused here and no request is made: it cannot exchange, and a request would only add a wrong
 * attempt to the ticket's counter (SEC 1.5 c).
 */
export function takeHandoff(env: HandoffEnv, loc: Pick<Location, 'hash' | 'pathname' | 'search'> = globalThis.location): Handoff {
  const hash = loc.hash;
  const hasFragment = hash !== '' && hash !== '#';
  if (hasFragment) stripFragment(loc);
  // A launch page view consumes `fp.lv` whatever the fragment turns out to be: the verifier was meant for this one navigation only, and a
  // refused link must not leave a valid one lying in the tab for the next page view.
  const stored = hasFragment ? takeVerifier() : null;

  const parsed = parseTicketFragment(hash, { apiBases: env.apiBases, devOverrides: env.devOverrides });
  if (parsed.ok) {
    const verifier = parsed.verifier ?? stored;
    if (verifier === null || !B64URL_43.test(verifier)) return { kind: 'failed', reason: 'no_verifier' };
    // One configured base: no selector needed. Several: the link must name one (parseTicketFragment already checked it is listed),
    // because sending the verifier to a base the link did not choose could hand it to the wrong server.
    const apiBase = parsed.api ?? (env.apiBases.length === 1 ? env.apiBases[0] : undefined);
    if (apiBase === undefined) return { kind: 'failed', reason: 'api_not_allowed' };
    return { kind: 'ticket', ticket: parsed.ticket, verifier, apiBase: apiBase.replace(/\/+$/, '') };
  }
  if (parsed.reason === 'legacy_descriptor') {
    if (!env.legacyDescriptor) return { kind: 'failed', reason: 'legacy_descriptor' };
    const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('fp');
    return fragment === null || fragment === '' ? { kind: 'failed', reason: 'malformed' } : { kind: 'legacy', fragment };
  }
  if (parsed.reason !== 'missing') return { kind: 'failed', reason: parsed.reason };

  const hint = readResume(env);
  return hint ? { kind: 'resume', hint } : { kind: 'failed', reason: 'missing' };
}

/* ── the resume hint ──────────────────────────────────────────────────────────────────────────────────────────── */

const idOrNull = (v: unknown, re: RegExp): string | null | undefined => (v === null ? null : typeof v === 'string' && re.test(v) ? v : undefined);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The URL policy of a return or reconnect URL on this side: this page's origin or `VITE_FP_RETURN_ORIGINS`, no userinfo, `http:` only when this page is. */
export function launchUrlPolicy(env: Pick<HandoffEnv, 'origin' | 'returnOrigins'>) {
  return { allowed_origins: [env.origin, ...env.returnOrigins].filter(Boolean), prefixes: ['/'], allow_http: env.origin.startsWith('http:') } as const;
}

/** A URL that passes the policy, normalised, or null. */
export function allowedUrl(raw: string | null | undefined, env: Pick<HandoffEnv, 'origin' | 'returnOrigins'>): string | null {
  if (typeof raw !== 'string') return null;
  const checked = checkLaunchUrl(raw, launchUrlPolicy(env));
  return checked.ok ? checked.url : null;
}

/** The stored hint, re-validated like any untrusted input (the storage is the tab's, but a page script of this origin can write it). */
export function readResume(env: Pick<HandoffEnv, 'origin' | 'returnOrigins'>): ResumeHint | null {
  const s = store();
  if (!s) return null;
  let raw: unknown;
  try {
    const text = s.getItem(RESUME_KEY);
    if (text === null) return null;
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== 5 || !['mode', 'master_id', 'record_id', 'reconnect_url', 'return_url'].every((k) => keys.includes(k))) return null;
  const mode = TICKET_MODES.find((m) => m === r.mode);
  const masterId = idOrNull(r.master_id, UUID);
  const recordId = idOrNull(r.record_id, IDENT);
  const reconnect = allowedUrl(r.reconnect_url as string, env);
  const back = allowedUrl(r.return_url as string, env);
  if (mode === undefined || masterId === undefined || recordId === undefined || reconnect === null || back === null) return null;
  return { mode, master_id: masterId, record_id: recordId, reconnect_url: reconnect, return_url: back };
}

/** Remembers the non-secret hint after a launch (and after a create gives the master an id). */
export function writeResume(hint: ResumeHint): void {
  try {
    store()?.setItem(RESUME_KEY, JSON.stringify({ mode: hint.mode, master_id: hint.master_id, record_id: hint.record_id, reconnect_url: hint.reconnect_url, return_url: hint.return_url }));
  } catch {
    /* no storage: a reload shows "open from DMS" */
  }
}

export function clearResume(): void {
  try {
    store()?.removeItem(RESUME_KEY);
  } catch {
    /* no storage */
  }
}

/* ── the legacy descriptor (M2 build only) ────────────────────────────────────────────────────────────────────── */

/** `fp.launch.<mode>`: the raw `#fp=` value of the legacy launch, so a reload keeps working in the M2 build. Never called in a default build. */
export function rememberLegacyFragment(mode: string, fragment: string): void {
  try {
    store()?.setItem(legacyKey(mode), fragment);
  } catch {
    /* no storage */
  }
}

export function recallLegacyFragment(mode: string): string | null {
  try {
    return store()?.getItem(legacyKey(mode)) ?? null;
  } catch {
    return null;
  }
}

export function forgetLegacyFragment(mode: string): void {
  try {
    store()?.removeItem(legacyKey(mode));
  } catch {
    /* no storage */
  }
}

/** For tests: forget everything this module keeps in the tab. */
export function clearHandoffStorage(): void {
  try {
    store()?.clear();
  } catch {
    /* no storage */
  }
}
