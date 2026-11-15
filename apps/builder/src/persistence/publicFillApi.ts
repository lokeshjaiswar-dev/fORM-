import { z } from 'zod';
import { RuntimeFormVersionSchema, RuntimeStatusSchema, type RuntimeFormVersion, type RuntimeStatus } from '@form/schema';
import { API_BASE } from '@/edition/edition';

/*
 * What the public fill page says to the API (`/v1/p/:slug`, WP-1.07 and WP-1.12). A respondent is anonymous: none of these
 * calls carries the session cookie, even from a browser that is signed in to the builder (`credentials: 'omit'`), so the
 * CSRF guard, which only looks at requests riding on that cookie, has nothing to refuse and an author can fill their own
 * live form.
 */

const loadedSchema = z.union([
  z.object({ redirectTo: z.string() }),
  z.object({
    slug: z.string(),
    formId: z.string(),
    status: RuntimeStatusSchema,
    /** Absent for a form behind its password until the request carries a valid access token: the definition is withheld. */
    version: RuntimeFormVersionSchema.optional(),
    media: z.record(z.string(), z.string()).optional(),
  }),
]);

export type PublicForm =
  | { kind: 'missing' }
  /** The address is one the form used to have: go to this one. */
  | { kind: 'redirect'; slug: string }
  | { kind: 'form'; slug: string; formId: string; status: RuntimeStatus; version: RuntimeFormVersion | null; media: Record<string, string> | undefined };

/** The API answered something a page cannot use (a 5xx, an answer that is not what the contract says): the caller may try again. */
export class PublicUnavailable extends Error {
  constructor(message = 'The form could not be loaded.') {
    super(message);
    this.name = 'PublicUnavailable';
  }
}

const url = (slug: string, tail = '') => `${API_BASE}/v1/p/${encodeURIComponent(slug)}${tail}`;

/**
 * The form at `slug`: its status now and, unless it is behind its password, its live version. `accessToken` (from an
 * unlock) is sent as `X-FR-Access`. A 404 is `missing`; a slug the form used to have is a `redirect` to the current one.
 */
export async function fetchPublicForm(slug: string, accessToken: string | null): Promise<PublicForm> {
  const res = await fetch(url(slug), { credentials: 'omit', headers: { accept: 'application/json', ...(accessToken ? { 'x-fr-access': accessToken } : {}) } });
  if (res.status === 404) return { kind: 'missing' };
  if (!res.ok) throw new PublicUnavailable();
  const parsed = loadedSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new PublicUnavailable('The form could not be read.');
  if ('redirectTo' in parsed.data) return { kind: 'redirect', slug: parsed.data.redirectTo };
  const { slug: current, formId, status, version, media } = parsed.data;
  return { kind: 'form', slug: current, formId, status, version: version ?? null, media };
}

export type Unlock = { kind: 'ok'; accessToken: string } | { kind: 'wrong' } | { kind: 'rate_limited' } | { kind: 'missing' };

/** Checks the password on the server (`POST /v1/p/:slug/unlock`): the token it hands back is for this form's live version and good for two hours. */
export async function unlockPublicForm(slug: string, password: string): Promise<Unlock> {
  const res = await fetch(url(slug, '/unlock'), {
    method: 'POST',
    credentials: 'omit',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (res.status === 401) return { kind: 'wrong' };
  if (res.status === 429) return { kind: 'rate_limited' };
  if (res.status === 404) return { kind: 'missing' };
  if (!res.ok) throw new PublicUnavailable();
  const parsed = z.object({ accessToken: z.string().min(1) }).safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new PublicUnavailable();
  return { kind: 'ok', accessToken: parsed.data.accessToken };
}

/** What a submission is sent as: the answers, the version they were made for, and what the page knows about the page view. */
export interface SubmissionBody {
  formVersionId: string;
  answers: unknown;
  fields: unknown;
  locale: string;
  client: Record<string, unknown>;
}

export type Submitted =
  | { kind: 'ok'; submissionId: string; endingId: string }
  /** 422 `SUBMISSION_INVALID`: each entry is a dotted path from the block and what is wrong with it. */
  | { kind: 'invalid'; errors: Array<{ path: string; message: string }> }
  /** 409 `VERSION_SUPERSEDED`: the form was republished after the page was built. */
  | { kind: 'version_superseded' }
  /** 409 `FORM_CLOSED`. */
  | { kind: 'closed' }
  /** 409 `LIMIT_REACHED`. */
  | { kind: 'limit_reached' }
  /** 401 `PASSWORD_REQUIRED`: the token ended (or was never given). */
  | { kind: 'password_required' }
  | { kind: 'rate_limited' }
  /** 404: the form is no longer published. */
  | { kind: 'missing' }
  /** 422 `IDEMPOTENCY_KEY_REUSED`: this key was already used for different answers. */
  | { kind: 'key_reused' };

const problemSchema = z.object({
  code: z.string().optional(),
  errors: z.array(z.object({ path: z.string().optional(), message: z.string().optional() })).optional(),
});

/**
 * `POST /v1/p/:slug/submissions` with an `Idempotency-Key`: the same key for every retry of one submission, so a retry
 * the first answer of which was lost gets that answer back and counts nothing twice. A refusal the page can act on comes
 * back as a `Submitted` kind; anything else (a 5xx, a network failure) throws, and the renderer offers a retry.
 */
export async function submitPublicForm(slug: string, body: SubmissionBody, idempotencyKey: string, accessToken: string | null): Promise<Submitted> {
  const res = await fetch(url(slug, '/submissions'), {
    method: 'POST',
    credentials: 'omit',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      ...(accessToken ? { 'x-fr-access': accessToken } : {}),
    },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    const parsed = z.object({ submissionId: z.string(), endingId: z.string() }).safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new PublicUnavailable();
    return { kind: 'ok', ...parsed.data };
  }
  const problem = problemSchema.safeParse(await res.json().catch(() => null));
  const code = problem.success ? problem.data.code : undefined;
  if (res.status === 422 && code === 'SUBMISSION_INVALID') {
    const errors = (problem.success ? (problem.data.errors ?? []) : []).flatMap((e) => (typeof e.message === 'string' ? [{ path: e.path ?? '', message: e.message }] : []));
    return { kind: 'invalid', errors };
  }
  if (res.status === 422 && code === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'key_reused' };
  if (res.status === 409 && code === 'VERSION_SUPERSEDED') return { kind: 'version_superseded' };
  if (res.status === 409 && code === 'FORM_CLOSED') return { kind: 'closed' };
  if (res.status === 409 && code === 'LIMIT_REACHED') return { kind: 'limit_reached' };
  if (res.status === 401 && code === 'PASSWORD_REQUIRED') return { kind: 'password_required' };
  if (res.status === 429) return { kind: 'rate_limited' };
  if (res.status === 404) return { kind: 'missing' };
  throw new PublicUnavailable();
}

/**
 * A UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then random bits. The `Idempotency-Key` of a submission is one, as the
 * contract says, so keys sort by when the attempt was made. The clock and the random source are parameters for tests;
 * `getRandomValues` (unlike `randomUUID`) also works when the page is served over plain http.
 */
export function uuidv7(nowMs: number = Date.now(), random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(16);
  for (let i = 0; i < 6; i += 1) bytes[5 - i] = Math.floor(nowMs / 2 ** (8 * i)) & 0xff;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** `scheme://host/path` of an http(s) address: no query, which can hold tokens and prefilled personal data, and no fragment. Undefined for anything else. */
export function addressWithoutQuery(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  try {
    const parsed = new URL(address);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? `${parsed.origin}${parsed.pathname}` : undefined;
  } catch {
    return undefined;
  }
}

/** The origin of a referrer: the site people came from, not the page or its query. Undefined for anything that is not an http(s) address. */
export function originOf(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  try {
    const parsed = new URL(address);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** The device class of a viewport `width` in CSS pixels, for the response's meta (the breakpoints the renderer's layout uses). */
export const deviceOf = (width: number): 'desktop' | 'tablet' | 'mobile' => (width >= 1024 ? 'desktop' : width >= 640 ? 'tablet' : 'mobile');

/** The respondent's IANA time zone as the browser reports it; undefined when it reports none. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
