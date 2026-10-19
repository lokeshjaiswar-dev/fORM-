import { create } from 'zustand';
import { z } from 'zod';
import { API_BASE } from '@/edition/edition';

/*
 * The builder's side of sign-in (WP-1.01): the session is an HttpOnly cookie the builder never reads; every call
 * goes with credentials, and every unsafe one with `X-FR-Client: builder`, which the API's CSRF guard requires
 * together with Fetch-Metadata (ADR-0008).
 */

export const CLIENT_HEADERS = { 'x-fr-client': 'builder' } as const;

export const meUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  emailVerified: z.boolean(),
  totpEnabled: z.boolean(),
});
export type MeUser = z.infer<typeof meUserSchema>;

export const signInResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('signed_in'), user: meUserSchema, recoveryCodesLeft: z.number().optional() }),
  z.object({ status: z.literal('mfa_required'), ticket: z.string(), methods: z.array(z.string()) }),
  z.object({ status: z.literal('link_sent') }),
]);
export type SignInResult = z.infer<typeof signInResultSchema>;

/** Who an emailed link is for, before it is used, and whether redeeming it here also needs the password. */
export const linkInfoSchema = z.object({ email: z.string(), passwordRequired: z.boolean() });
export type LinkInfo = z.infer<typeof linkInfoSchema>;

export const methodsSchema = z.object({ password: z.boolean(), emailLinks: z.boolean(), oauth: z.array(z.enum(['google', 'microsoft'])) });
export type AuthMethods = z.infer<typeof methodsSchema>;

const meSchema = z.object({
  user: meUserSchema,
  session: z.object({ id: z.string(), mfaLevel: z.string(), expiresAt: z.string() }).nullable(),
  orgs: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string(), role: z.string() })),
});
export type Me = z.infer<typeof meSchema>;

/** An API refusal as problem+json: the code and the server's sentence for people. */
export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.name = 'ApiProblem';
    this.status = status;
    this.code = code;
  }
}

/** Neither a problem nor an answer: the API is unreachable or answered something unexpected. */
export class ApiUnreachable extends Error {
  constructor() {
    super('unreachable');
    this.name = 'ApiUnreachable';
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'DELETE', path: string, schema: z.ZodType<T> | null, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers: { accept: 'application/json', ...(method === 'GET' ? {} : CLIENT_HEADERS), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiUnreachable();
  }
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    if (type.includes('json')) {
      const p = (await res.json().catch(() => ({}))) as { code?: unknown; detail?: unknown; title?: unknown };
      throw new ApiProblem(res.status, typeof p.code === 'string' ? p.code : 'UNKNOWN', typeof p.detail === 'string' ? p.detail : typeof p.title === 'string' ? p.title : '');
    }
    throw new ApiUnreachable();
  }
  if (schema === null) return undefined as T;
  if (!type.includes('json')) throw new ApiUnreachable();
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new ApiUnreachable();
  return parsed.data;
}

export type SessionState = { status: 'unknown' } | { status: 'signed_out' } | { status: 'unreachable' } | { status: 'signed_in'; me: Me };

export const useSessionStore = create<SessionState>(() => ({ status: 'unknown' }));

/** Asks the API who is signed in; a 401 means nobody. */
export async function loadSession(): Promise<SessionState> {
  let next: SessionState;
  try {
    next = { status: 'signed_in', me: await api('GET', '/v1/me', meSchema) };
  } catch (err) {
    next = err instanceof ApiProblem && err.status === 401 ? { status: 'signed_out' } : { status: 'unreachable' };
  }
  useSessionStore.setState(next, true);
  return next;
}

/** Signs out here even when the server cannot be told (the session then ends with its expiry). */
export async function signOut(): Promise<void> {
  try {
    await api('POST', '/v1/auth/logout', null);
  } catch {
    /* Already signed out, or unreachable. */
  }
  useSessionStore.setState({ status: 'signed_out' }, true);
}

export const fetchMethods = () => api('GET', '/v1/auth/methods', methodsSchema);

/** Where the browser goes to start Google or Microsoft sign-in (a top-level navigation to the API). */
export const oauthStartUrl = (provider: 'google' | 'microsoft') => `${API_BASE}/v1/auth/oauth/${provider}/start`;

/** `#token=…` or `#ticket=…` from the address bar, which the email link or the OAuth callback put there. */
export function fragmentParam(hash: string, name: 'token' | 'ticket' | 'error'): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get(name);
}
