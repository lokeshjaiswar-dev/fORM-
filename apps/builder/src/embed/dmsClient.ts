/*
 * A small client for dms-api, used by the embed modes. The user's DMS token goes only to the launch's `apiBase`, which
 * `launch.ts` has already checked against the allowlist. There is deliberately no fallback token: no token, no request.
 */

const TOKEN_COOKIES = ['Authorization', 'authorization', 'token', 'access_token'] as const;
const REQUEST_TIMEOUT_MS = 30_000;

function cookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const wanted = encodeURIComponent(name);
  for (const part of document.cookie.split('; ')) {
    const at = part.indexOf('=');
    if ((at >= 0 ? part.slice(0, at) : part) !== wanted) continue;
    try {
      return decodeURIComponent(at >= 0 ? part.slice(at + 1) : '');
    } catch {
      return null;
    }
  }
  return null;
}

/** The DMS user token as the DMS frontends keep it (cookies `Authorization`/`token`/`access_token`, then localStorage `token`). Without the `Bearer ` prefix. */
export function readDmsToken(): string | null {
  const clean = (v: string | null | undefined): string | null => {
    const s = (v ?? '').trim().replace(/^Bearer\s+/i, '').replace(/^["']+|["']+$/g, '').trim();
    return s !== '' && s !== 'undefined' && s !== 'null' ? s : null;
  };
  for (const name of TOKEN_COOKIES) {
    const v = clean(cookie(name));
    if (v) return v;
  }
  try {
    return clean(globalThis.localStorage?.getItem('token'));
  } catch {
    return null;
  }
}

/** The user has no DMS session, or dms-api refused the token (401). */
export class DmsAuthError extends Error {
  constructor(message = 'Sign in to DMS again.') {
    super(message);
    this.name = 'DmsAuthError';
  }
}

/** dms-api answered with an error: `status`, its `code` (e.g. `MASTER_CHANGED`, `DUPLICATE_FIELD_NAME`) and message. */
export class DmsApiError extends Error {
  readonly status: number;
  readonly code: string | number | null;
  readonly body: unknown;
  constructor(status: number, message: string, code: string | number | null, body: unknown) {
    super(message);
    this.name = 'DmsApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface DmsClientOptions {
  apiBase: string;
  tenantId: string;
  workspaceId: string;
  /** For tests; defaults to `window.fetch`. */
  fetch?: typeof fetch;
  /** For tests; defaults to `readDmsToken`. */
  token?: () => string | null;
}

export interface DmsClient {
  request<T = unknown>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first message dms-api gave: `message`, else the first validation error. */
function messageOf(body: unknown, status: number): string {
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

export function createDmsClient(options: DmsClientOptions): DmsClient {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = options.token ?? readDmsToken;
  return {
    async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      const bearer = token();
      if (!bearer) throw new DmsAuthError();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await doFetch(`${options.apiBase}${path}`, {
          method,
          // The token is sent as a header, never as a cookie: nothing else rides along to another origin.
          credentials: 'omit',
          // A redirect would carry the bearer to wherever the first answer points.
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${bearer}`,
            'X-Tenant-Id': options.tenantId,
            'X-Workspace-Id': options.workspaceId,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (e) {
        if (controller.signal.aborted) throw new Error('DMS did not answer in time. Try again.');
        throw new Error(`DMS cannot be reached (${e instanceof Error ? e.message : String(e)}).`);
      } finally {
        clearTimeout(timer);
      }
      let parsed: unknown = null;
      const text = await response.text().catch(() => '');
      if (text !== '') {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      if (response.status === 401) throw new DmsAuthError();
      if (!response.ok) {
        const code = isRecord(parsed) && (typeof parsed.code === 'string' || typeof parsed.code === 'number') ? parsed.code : null;
        throw new DmsApiError(response.status, messageOf(parsed, response.status), code, parsed);
      }
      return parsed as T;
    },
  };
}
