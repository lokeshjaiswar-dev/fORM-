import { SESSION_ROUTE_MAP } from '@/embed/contract';
import type { DmsClient, DmsClientOptions } from '@/embed/session/clientTypes';
import { authorizedFetch, currentGeneration, SessionEndedError, sessionApiBase, waitForReconnect } from '@/embed/session/dmsSession';
import { legacyClientFactory } from '@/embed/session/legacySlot';
import { newRequestId } from '@/embed/session/pkce';

/*
 * The client the embed pages use for dms-api (DESIGN 3.3, 5.1, SEC-DESIGN 1.6, 1.9). `createDmsClient` keeps its call shape, but it
 * now returns the SESSION client:
 *
 *   - the pages and repositories keep writing the legacy paths (`/dms/v1/master/form/{id}`); `toSessionRoute` maps them to the
 *     session group with `SESSION_ROUTE_MAP` (an exact template match). A path that is not in the table is a programming error: it
 *     throws and nothing is sent;
 *   - `Authorization: Bearer fps1_...` comes from the credential module (`session/dmsSession.ts`); this file never holds it;
 *   - no `X-Tenant-Id`, no `X-Workspace-Id` (dms-api takes both from the session), `X-Request-Id` (UUID v4) on every call;
 *   - requests go only to the API base the session was exchanged with, which is the build-time `VITE_FP_DMS_API_BASE` (exact match);
 *   - `credentials: 'omit'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'`, 30 s timeout;
 *   - a 401 `FP_SESSION_INVALID` / `FP_CONTEXT_MISMATCH` parks the call: the page shows "Reconnect to DMS" over the kept state and
 *     the call is retried ONCE after a successful reconnect, or fails with `DmsAuthError` when the user dismisses the prompt.
 *
 * Nothing here reads a cookie or storage. The old cookie reader is `embed/legacy/cookieToken.ts` (M2 build only).
 */

const REQUEST_TIMEOUT_MS = 30_000;

export type { DmsClient, DmsClientOptions };

/** The user has no DMS session, or dms-api refused the credential (401) and no reconnect followed. */
export class DmsAuthError extends Error {
  constructor(message = 'Sign in to DMS again.') {
    super(message);
    this.name = 'DmsAuthError';
  }
}

/** dms-api answered with an error: `status`, its `code` (e.g. `MASTER_CHANGED`, `FP_SCOPE_DENIED`), its message and the request id. */
export class DmsApiError extends Error {
  readonly status: number;
  readonly code: string | number | null;
  readonly body: unknown;
  /** The `request_id` of the error envelope, else the `X-Request-Id` this call sent: what the error panels show as "Reference". */
  readonly requestId: string | null;
  constructor(status: number, message: string, code: string | number | null, body: unknown, requestId: string | null = null) {
    super(message);
    this.name = 'DmsApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.requestId = requestId;
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first message dms-api gave: `message`, else the first validation error. */
export function messageOf(body: unknown, status: number): string {
  if (isRecord(body)) {
    if (typeof body.message === 'string' && body.message !== '') {
      const errors = isRecord(body.errors) ? Object.values(body.errors).flat().filter((v): v is string => typeof v === 'string') : [];
      return errors.length > 0 ? `${body.message} ${errors[0]}` : body.message;
    }
    if (isRecord(body.errors)) {
      const first = Object.values(body.errors).flat().find((v): v is string => typeof v === 'string');
      if (first) return first;
    }
  }
  return `DMS answered ${status}.`;
}

/** The parsed JSON body of an answer, or null (empty, not JSON). */
export async function readAnswer(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/* ── the path map (DT-08) ─────────────────────────────────────────────────────────────────────────────────────── */

export interface SessionRouteHit {
  /** The session path (relative to the API base) with the query string, ready to append to the base. */
  path: string;
  /** The route name of the contract (`fp.s.master-records.update`). */
  name: string;
}

const SEGMENT_OK = /^[A-Za-z0-9._~%:-]+$/;
/** Context a caller may not choose (SEC 1.6 `fp.resolve:session`): dms-api answers `401 FP_CONTEXT_MISMATCH` for them, so they are not sent. */
const FORBIDDEN_QUERY_KEYS = new Set(['tenant_id', 'tenantid', 'workspace_id', 'workspaceid']);

/**
 * Maps a legacy path (`/dms/v1/master/form/{id}`, `dms/master-records?id=..&q=..`) and method to the session route, by an exact match on
 * the path template (`{id}` is one path segment). Anything else throws: an unknown path, a method the template does not have,
 * dot segments, a `//`, a backslash, an absolute URL, or a query that names a tenant or workspace.
 */
export function toSessionRoute(method: string, rawPath: string): SessionRouteHit {
  const fail = (why: string): never => {
    throw new Error(`fORM- has no session route for ${method} ${rawPath.split('?')[0] ?? ''} (${why}); nothing was sent.`);
  };
  if (/[\\\s#]/.test(rawPath) || /^[a-z][a-z0-9+.-]*:/i.test(rawPath) || rawPath.startsWith('//')) return fail('not a relative API path');
  const [pathOnly = '', ...queryParts] = rawPath.split('?');
  const query = queryParts.join('?');
  const clean = pathOnly.replace(/^\/+/, '');
  const parts = clean.split('/');
  if (clean === '' || clean.includes('//') || /%2e|%2f|%5c/i.test(clean) || parts.some((s) => s === '.' || s === '..' || !SEGMENT_OK.test(s))) return fail('unusual path');
  if (query !== '') {
    for (const pair of query.split('&')) {
      let key = pair.split('=')[0] ?? '';
      try {
        key = decodeURIComponent(key.replace(/\+/g, ' '));
      } catch {
        return fail('malformed query');
      }
      if (FORBIDDEN_QUERY_KEYS.has(key.toLowerCase())) return fail('the query names a tenant or workspace');
    }
  }
  for (const route of SESSION_ROUTE_MAP) {
    if (route.legacy === null || route.method !== method) continue;
    const template = route.legacy.split('/');
    if (template.length !== parts.length) continue;
    const ids: string[] = [];
    const matches = template.every((t, i) => {
      if (t === '{id}') {
        ids.push(parts[i] ?? '');
        return true;
      }
      return t === parts[i];
    });
    if (!matches) continue;
    let session: string = route.session;
    for (const id of ids) session = session.replace('{id}', id);
    return { path: query === '' ? session : `${session}?${query}`, name: route.name };
  }
  return fail('not in SESSION_ROUTE_MAP');
}

/* ── the session client ───────────────────────────────────────────────────────────────────────────────────────── */

const normalise = (base: string): string => base.replace(/\/+$/, '');

function sessionClient(options: DmsClientOptions): DmsClient {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  return {
    async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      const route = toSessionRoute(method, path);
      let requestId = newRequestId();
      const send = async (): Promise<Response | null> => {
        const base = sessionApiBase();
        if (base === null) return null;
        // A caller naming another API base is a bug: the credential goes to the session's own base or nowhere.
        if (options.apiBase !== '' && normalise(options.apiBase) !== base) throw new Error('fORM- sends session requests only to the DMS API base of the launch; nothing was sent.');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          return await authorizedFetch(doFetch, `${base}/${route.path}`, {
            method,
            signal: controller.signal,
            headers: {
              Accept: 'application/json',
              'X-Request-Id': requestId,
              ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        } catch (e) {
          if (e instanceof SessionEndedError) return null;
          if (controller.signal.aborted) throw new Error('DMS did not answer in time. Try again.');
          throw new Error(`DMS cannot be reached (${e instanceof Error ? e.message : String(e)}).`);
        } finally {
          clearTimeout(timer);
        }
      };

      let retried = false;
      for (;;) {
        const generation = currentGeneration();
        const response = await send();
        if (response === null) throw new DmsAuthError();
        const parsed = await readAnswer(response);
        if (response.status === 401) {
          const code = isRecord(parsed) && typeof parsed.code === 'string' ? parsed.code : null;
          // The session is gone but the page is kept: park until the user reconnects (state kept, request retried once).
          if (!retried && (code === 'FP_SESSION_INVALID' || code === 'FP_CONTEXT_MISMATCH' || code === null)) {
            try {
              await waitForReconnect(generation);
            } catch {
              throw new DmsAuthError();
            }
            retried = true;
            requestId = newRequestId();
            continue;
          }
          throw new DmsAuthError();
        }
        if (!response.ok) {
          const code = isRecord(parsed) && (typeof parsed.code === 'string' || typeof parsed.code === 'number') ? parsed.code : null;
          const echoed = isRecord(parsed) && typeof parsed.request_id === 'string' ? parsed.request_id : null;
          throw new DmsApiError(response.status, messageOf(parsed, response.status), code, parsed, echoed ?? requestId);
        }
        return parsed as T;
      }
    },
  };
}

/**
 * The client of the current launch. Same call shape as before: `apiBase`, `tenantId`, `workspaceId` are accepted and ignored (see
 * `DmsClientOptions`). In the M2 legacy build a `#fp=` launch gets the old transport instead (`embed/legacy`).
 */
export function createDmsClient(options: DmsClientOptions): DmsClient {
  const legacy = legacyClientFactory();
  return legacy ? legacy(options) : sessionClient(options);
}
