import { ExchangeResponseSchema, SESSION_ROUTE_MAP, type ExchangeResponse, type SessionContext, type TicketMode } from '@/embed/contract';
import { allowedUrl, clearResume, writeResume, type HandoffEnv, type ResumeHint } from './handoff';
import { newRequestId } from './pkce';

/*
 * The session credential and everything that keeps it alive (SEC-DESIGN 1.3-1.9, DESIGN 5.1).
 *
 * THE RULE (SEC 1.9 rule 1): the credential `fps1_...` lives in ONE module-scope variable, `credential`, in this file. Never in React
 * state, a store, `window`, any storage, a URL, a message, a log line or an error. No function here returns it; the only way it
 * leaves is `authorizedFetch`, which puts it in the `Authorization` header of a request to the allowlisted DMS API base and nowhere
 * else. fORM- sends no `X-Tenant-Id` and no `X-Workspace-Id`: dms-api decides the tenant and workspace from the session.
 *
 * What the rest of fORM- may read is the non-secret `SessionSnapshot` (phase, context). The reconnect flow is in `./reconnect.ts`
 * and uses the `internal*` functions below.
 */

/* ── the one variable ─────────────────────────────────────────────────────────────────────────────────────────── */

let credential: string | null = null;

/* ── state the UI may read ────────────────────────────────────────────────────────────────────────────────────── */

/**
 *  none      no launch yet
 *  active    credential held
 *  expiring  active, and less than 5 minutes to the absolute expiry: the UI offers "Reconnect" (SEC 1.7)
 *  invalid   dms-api answered 401 FP_SESSION_INVALID / FP_CONTEXT_MISMATCH: the page is kept, the UI offers "Reconnect"
 *  ended     no credential: the session was left (pagehide, save, cancel) or this is a reload with a resume hint
 *  mismatch  a reconnect produced another identity: the page is blocked and the new credential was discarded
 */
export type SessionPhase = 'none' | 'active' | 'expiring' | 'invalid' | 'ended' | 'mismatch';

/** Where a reconnect stands: nothing started, waiting for the DMS tab, exchanging its ticket, or failed. */
export type ReconnectState = 'idle' | 'waiting' | 'exchanging' | 'failed';

export interface SessionSnapshot {
  readonly phase: SessionPhase;
  /** The page's identity: from the first exchange, or (after a reload) from a reconnect. Null before and for a resume. */
  readonly context: SessionContext | null;
  /** The allowlisted API base this session was exchanged with. */
  readonly apiBase: string | null;
  /** The non-secret hint of a reload ("Session ended"). */
  readonly resume: ResumeHint | null;
  /** The user closed the reconnect prompt; a later 401 shows it again. */
  readonly dismissed: boolean;
  readonly reconnect: ReconnectState;
}

const INITIAL: SessionSnapshot = { phase: 'none', context: null, apiBase: null, resume: null, dismissed: false, reconnect: 'idle' };
let snapshot: SessionSnapshot = INITIAL;
const listeners = new Set<() => void>();

function publish(next: Partial<SessionSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const l of [...listeners]) l();
}

export const sessionSnapshot = (): SessionSnapshot => snapshot;
export const subscribeSession = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const sessionContext = (): SessionContext | null => snapshot.context;
export const sessionApiBase = (): string | null => snapshot.apiBase;

/** Bumps whenever a credential is installed or dropped: a request that got a 401 can tell "I used the old one". */
let generation = 0;
export const currentGeneration = (): number => generation;

/* ── errors ───────────────────────────────────────────────────────────────────────────────────────────────────── */

/** There is no session (never launched, left, or the user dismissed the reconnect prompt). `dmsClient` turns it into `DmsAuthError`. */
export class SessionEndedError extends Error {
  constructor(message = 'The DMS session has ended.') {
    super(message);
    this.name = 'SessionEndedError';
  }
}

export type ExchangeFailure = 'ticket_invalid' | 'unavailable' | 'unreachable' | 'invalid_response' | 'rejected';

/** The exchange did not give a session. `reason` is all the page shows; the ticket, verifier and body never travel in the error. */
export class ExchangeError extends Error {
  readonly reason: ExchangeFailure;
  readonly code: string | null;
  constructor(reason: ExchangeFailure, code: string | null = null) {
    super(`Forms+ launch failed (${reason}).`);
    this.name = 'ExchangeError';
    this.reason = reason;
    this.code = code;
  }
}

/* ── the exchange ─────────────────────────────────────────────────────────────────────────────────────────────── */

const REQUEST_TIMEOUT_MS = 30_000;
const routePath = (name: string): string => SESSION_ROUTE_MAP.find((r) => r.name === name)?.session ?? '';
const SESSION_PATH = routePath('fp.s.session.show');
export const EXCHANGE_PATH = 'dms/v1/formplus/launch-tickets/exchange';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

type FetchFn = typeof fetch;
const defaultFetch: FetchFn = (input, init) => globalThis.fetch(input, init);

/**
 * `POST {apiBase}/dms/v1/formplus/launch-tickets/exchange` with `{ticket, verifier}` and NO `Authorization` (SEC 1.5). The answer is
 * validated against the contract schema; nothing is stored here: `installSession` / `reconnect.ts` decide what happens next.
 */
export async function exchangeTicket(args: { apiBase: string; ticket: string; verifier: string; fetch?: FetchFn }): Promise<ExchangeResponse> {
  const doFetch = args.fetch ?? defaultFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(`${args.apiBase}/${EXCHANGE_PATH}`, {
      method: 'POST',
      // No cookie, no Authorization: the ticket and the verifier are the whole request.
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Request-Id': newRequestId() },
      body: JSON.stringify({ ticket: args.ticket, verifier: args.verifier }),
    });
  } catch {
    throw new ExchangeError('unreachable');
  } finally {
    clearTimeout(timer);
  }
  const body = await readJson(response);
  if (response.status === 200) {
    const parsed = ExchangeResponseSchema.safeParse(body);
    if (!parsed.success) throw new ExchangeError('invalid_response');
    return parsed.data;
  }
  const code = isRecord(body) && typeof body.code === 'string' ? body.code : null;
  if (response.status === 401 || code === 'FP_TICKET_INVALID') throw new ExchangeError('ticket_invalid', code);
  if (response.status === 503 || response.status === 429 || code === 'LAUNCH_STORE_UNAVAILABLE' || code === 'RATE_LIMITED') throw new ExchangeError('unavailable', code);
  throw new ExchangeError('rejected', code);
}

/* ── installing a session ─────────────────────────────────────────────────────────────────────────────────────── */

const KEEPALIVE_MS = 10 * 60_000;
/** A keep-alive is sent only when the user typed or clicked within this window (SEC 1.7): an abandoned tab dies after the idle TTL. */
const INPUT_WINDOW_MS = 10 * 60_000;
/** The Reconnect prompt appears this long before the absolute expiry (SEC 1.7). */
const EXPIRY_WARNING_MS = 5 * 60_000;

let keepAliveTimer: ReturnType<typeof setTimeout> | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let lastInput = Date.now();
let listening = false;
let activeFetch: FetchFn = defaultFetch;

function stopTimers(): void {
  if (keepAliveTimer !== null) clearTimeout(keepAliveTimer);
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  keepAliveTimer = null;
  expiryTimer = null;
}

const noteInput = (): void => {
  lastInput = Date.now();
};
const onPageHide = (): void => {
  void leaveSession();
};

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  for (const ev of ['keydown', 'pointerdown', 'touchstart'] as const) window.addEventListener(ev, noteInput, { capture: true, passive: true });
  window.addEventListener('pagehide', onPageHide);
}

function stopListening(): void {
  if (!listening || typeof window === 'undefined') return;
  listening = false;
  for (const ev of ['keydown', 'pointerdown', 'touchstart'] as const) window.removeEventListener(ev, noteInput, { capture: true });
  window.removeEventListener('pagehide', onPageHide);
}

function scheduleTimers(absoluteSeconds: number): void {
  stopTimers();
  keepAliveTimer = setTimeout(() => void keepAliveTick(), KEEPALIVE_MS);
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    if (snapshot.phase === 'active') publish({ phase: 'expiring', dismissed: false });
  }, Math.max(0, absoluteSeconds * 1000 - EXPIRY_WARNING_MS));
}

/** Keep-alive: `GET s/session` while the tab is visible AND the user typed or clicked in the last 10 minutes. A 401 offers Reconnect. */
async function keepAliveTick(): Promise<void> {
  keepAliveTimer = setTimeout(() => void keepAliveTick(), KEEPALIVE_MS);
  if (credential === null || (snapshot.phase !== 'active' && snapshot.phase !== 'expiring')) return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  if (Date.now() - lastInput >= INPUT_WINDOW_MS) return;
  const gen = generation;
  try {
    const response = await authorizedFetch(activeFetch, `${snapshot.apiBase}/${SESSION_PATH}`, { method: 'GET', headers: { Accept: 'application/json', 'X-Request-Id': newRequestId() } });
    if (gen !== generation) return;
    if (response.status === 401) return markInvalid();
    if (!response.ok) return;
    const body = await readJson(response);
    const data = isRecord(body) && isRecord(body.data) ? body.data : body;
    if (isRecord(data) && typeof data.absolute_expires_in === 'number' && data.absolute_expires_in > 0 && gen === generation) scheduleAbsolute(data.absolute_expires_in);
  } catch {
    /* DMS cannot be reached: the next tick tries again; a real expiry shows on the next page request */
  }
}

/** Re-arms only the absolute-expiry prompt (the server's own remaining time, in seconds). */
function scheduleAbsolute(absoluteSeconds: number): void {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  const wait = absoluteSeconds * 1000 - EXPIRY_WARNING_MS;
  if (wait <= 0) {
    expiryTimer = null;
    if (snapshot.phase === 'active') publish({ phase: 'expiring', dismissed: false });
    return;
  }
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    if (snapshot.phase === 'active') publish({ phase: 'expiring', dismissed: false });
  }, wait);
}

function hintOf(context: SessionContext): ResumeHint {
  return { mode: context.mode, master_id: context.master_id, record_id: context.record_id, reconnect_url: context.reconnect_url, return_url: context.return_url };
}

/** Writes the resume hint when both URLs pass the allowlist; otherwise there is nothing safe to resume with, so none is kept. */
function persistHint(context: SessionContext, env: HandoffEnv): void {
  const reconnect = allowedUrl(context.reconnect_url, env);
  const back = allowedUrl(context.return_url, env);
  if (reconnect === null || back === null) return clearResume();
  writeResume({ ...hintOf(context), reconnect_url: reconnect, return_url: back });
}

/**
 * The first exchange succeeded: keep the credential in the module variable, remember the identity the page runs under, start the
 * keep-alive and the expiry prompt, and leave the non-secret resume hint for a reload.
 */
export function installSession(response: ExchangeResponse, apiBase: string, env: HandoffEnv, doFetch?: FetchFn): void {
  credential = response.credential;
  generation += 1;
  activeFetch = doFetch ?? defaultFetch;
  lastInput = Date.now();
  listen();
  scheduleTimers(response.absolute_expires_in);
  persistHint(response.context, env);
  publish({ phase: 'active', context: response.context, apiBase, resume: null, dismissed: false, reconnect: 'idle' });
}

/* ── requests ─────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The only place the credential leaves this module: `Authorization: Bearer` of a request to `apiBase`. The URL must be under the
 * session's own API base (an allowlisted build-time value), so a bug elsewhere cannot send it somewhere else. Cookies are never
 * sent, a redirect is an error, and no referrer goes out.
 */
export function authorizedFetch(doFetch: FetchFn, url: string, init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }): Promise<Response> {
  const base = snapshot.apiBase;
  if (credential === null || base === null) throw new SessionEndedError();
  if (!url.startsWith(`${base}/`)) throw new Error('Refusing to send the session credential outside the DMS API base.');
  return doFetch(url, {
    ...init,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: { ...init.headers, Authorization: `Bearer ${credential}` },
  });
}

/* ── 401: park the call until a reconnect ─────────────────────────────────────────────────────────────────────── */

interface Parked {
  resolve: () => void;
  reject: (e: Error) => void;
}
let parked: Parked[] = [];

/** dms-api refused the credential (401 FP_SESSION_INVALID or FP_CONTEXT_MISMATCH): the page is kept and the UI offers Reconnect. */
export function markInvalid(): void {
  if (snapshot.phase === 'active' || snapshot.phase === 'expiring') publish({ phase: 'invalid', dismissed: false });
}

/**
 * A request that used credential generation `usedGeneration` got 401. Resolves when a reconnect has installed a newer credential
 * (the caller retries once); rejects with `SessionEndedError` when the user dismisses the prompt, the reconnect is blocked, or there
 * is nothing to reconnect.
 */
export function waitForReconnect(usedGeneration: number): Promise<void> {
  if (generation !== usedGeneration && credential !== null) return Promise.resolve();
  if (snapshot.phase === 'mismatch' || snapshot.phase === 'none') return Promise.reject(new SessionEndedError());
  markInvalid();
  if (snapshot.phase === 'invalid' || snapshot.phase === 'ended') {
    if (snapshot.dismissed) publish({ dismissed: false });
    return new Promise<void>((resolve, reject) => parked.push({ resolve, reject }));
  }
  return Promise.reject(new SessionEndedError());
}

function releaseParked(error: Error | null): void {
  const calls = parked;
  parked = [];
  for (const p of calls) error ? p.reject(error) : p.resolve();
}

/** The user closed the Reconnect prompt: parked calls fail with `SessionEndedError` (the page shows its own message). */
export function dismissReconnect(): void {
  publish({ dismissed: true });
  releaseParked(new SessionEndedError());
}

/* ── leaving ──────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * `DELETE s/session` with `keepalive: true` (it survives the navigation that follows a save or cancel), then the credential is
 * dropped. Called on `pagehide`. The resume hint stays, so a reload or a Back shows "Session ended" with a Reconnect button.
 */
export async function leaveSession(opts: { forget?: boolean } = {}): Promise<void> {
  const base = snapshot.apiBase;
  const held = credential !== null;
  if (held && base !== null) {
    try {
      await authorizedFetch(activeFetch, `${base}/${routePath('fp.s.session.destroy')}`, {
        method: 'DELETE',
        keepalive: true,
        headers: { Accept: 'application/json', 'X-Request-Id': newRequestId() },
      });
    } catch {
      /* leaving: nothing to tell anyone; the server's idle TTL ends the session anyway */
    }
  }
  credential = null;
  generation += 1;
  stopTimers();
  stopListening();
  if (opts.forget) clearResume();
  if (snapshot.phase !== 'none' && snapshot.phase !== 'mismatch') publish({ phase: 'ended', reconnect: 'idle' });
  releaseParked(new SessionEndedError());
}

/* ── for reconnect.ts and the gate ────────────────────────────────────────────────────────────────────────────── */

/** @internal reconnect.ts: a matching identity came back; swap the credential, restart the timers, resume parked calls. */
export function internalReplaceCredential(response: ExchangeResponse, env: HandoffEnv, apiBase: string, doFetch?: FetchFn): void {
  credential = response.credential;
  generation += 1;
  if (doFetch) activeFetch = doFetch;
  lastInput = Date.now();
  listen();
  scheduleTimers(response.absolute_expires_in);
  if (snapshot.context === null) {
    // A reload: the reconnect gives the page its identity.
    persistHint(response.context, env);
    publish({ phase: 'active', context: response.context, apiBase, resume: null, dismissed: false, reconnect: 'idle' });
  } else {
    publish({ phase: 'active', apiBase, dismissed: false, reconnect: 'idle' });
  }
  releaseParked(null);
}

/** @internal reconnect.ts: the new credential belongs to someone else (or another master): it was never stored; the page is blocked. */
export function internalBlockMismatch(): void {
  credential = null;
  generation += 1;
  stopTimers();
  publish({ phase: 'mismatch', reconnect: 'idle' });
  releaseParked(new SessionEndedError('You are signed in as someone else.'));
}

/** @internal reconnect.ts: progress of the reconnect, shown by the prompt. */
export function internalSetReconnect(state: ReconnectState): void {
  publish({ reconnect: state });
}

/** A reload with a resume hint: "Session ended". No credential, no request. */
export function enterResume(hint: ResumeHint): void {
  publish({ phase: 'ended', context: null, resume: hint, dismissed: false, reconnect: 'idle' });
}

/**
 * After a create gave the master an id the page's identity is "edit this master": a reconnect asks for an edit ticket and the
 * context it returns is compared against this, and a reload resumes into the master instead of creating a second one.
 */
export function setContextMasterId(masterId: string, env: HandoffEnv): void {
  const ctx = snapshot.context;
  if (ctx === null || ctx.master_id === masterId) return;
  const next = { ...ctx, master_id: masterId, master_seed: null };
  persistHint(next, env);
  publish({ context: next });
}

/** The mode of the page's identity (what the gate compares with its route). */
export const sessionMode = (): TicketMode | null => snapshot.context?.mode ?? null;

/* ── one launch per page view ─────────────────────────────────────────────────────────────────────────────────── */

const launches = new Map<string, Promise<unknown>>();

/** Runs `create` once per `key` for this page view and hands every later caller the same promise (a StrictMode remount must not launch twice). */
export function memoLaunch<T>(key: string, create: () => Promise<T>): Promise<T> {
  let kept = launches.get(key) as Promise<T> | undefined;
  if (kept === undefined) {
    kept = create();
    launches.set(key, kept);
  }
  return kept;
}

/** A retried launch replaces the failed one in the memo. */
export function replaceLaunchMemo<T>(key: string, value: T): void {
  launches.set(key, Promise.resolve(value));
}

/** For tests: back to a page that was never launched, with no timers and no listeners. */
export function resetSessionForTests(): void {
  launches.clear();
  credential = null;
  generation += 1;
  stopTimers();
  stopListening();
  parked = [];
  activeFetch = defaultFetch;
  lastInput = Date.now();
  snapshot = INITIAL;
  for (const l of [...listeners]) l();
}
