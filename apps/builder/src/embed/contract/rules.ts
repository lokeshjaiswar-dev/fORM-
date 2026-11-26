import {
  B64URL_43_RE,
  RESERVED_MODES,
  SHARE_TOKEN_LEGACY_RE,
  SHARE_TOKEN_V2_RE,
  TICKET_RE,
  TicketRequestSchema,
  ReturnParamsSchema,
  shareTokenExpiry,
  type ErrorCode,
  type ReturnParams,
  type ShareLinkKind,
} from './schemas';

/*
 * The pure rules the contract fixtures exercise (DESIGN 3.2, SEC 1.3-1.4, 3.4, 6.3). They are the reference the other repos
 * mirror in their own language: dms-api (`LaunchTicketController`), classic and dms-ui (`ticket.ts` / `formplus.ts`), fORM-
 * (`session/handoff.ts`). Nothing here reads a cookie, storage or the network.
 */

/* ------------------------------------------------------------------------------------------------ return and reconnect URLs */

export interface LaunchUrlPolicy {
  /** `config('formplus.launch.allowed_origins')`: exact origins (`https://app.example.test`, no path). Empty denies everything. */
  allowed_origins: readonly string[];
  /** `config('formplus.launch.return_path_prefixes')`: the path must start with one of them. */
  prefixes: readonly string[];
  /** `config('formplus.launch.allow_http')`: true only on LAN and test http stacks. */
  allow_http: boolean;
}

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: 'too_long' | 'not_absolute' | 'scheme' | 'userinfo' | 'origin' | 'path' };

const normalOrigin = (origin: string): string => origin.trim().replace(/\/+$/, '').toLowerCase();

/**
 * `return_url` and `reconnect_url` of a ticket request: absolute `https:` (or `http:` with `allow_http`), no userinfo, origin on the
 * allowlist, path under one of the prefixes, at most 2048 characters. Dot segments and backslashes are refused outright instead of
 * being normalised, so a PHP `parse_url` and a browser cannot disagree about where the link points.
 */
export function checkLaunchUrl(raw: string, policy: LaunchUrlPolicy): UrlCheck {
  if (raw.length > 2048) return { ok: false, reason: 'too_long' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /[\\\s]/.test(raw) || [...raw].some((ch) => ch.charCodeAt(0) < 0x20)) return { ok: false, reason: 'not_absolute' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not_absolute' };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.allow_http)) return { ok: false, reason: 'scheme' };
  if (url.username !== '' || url.password !== '' || /^[^/]*@/.test(raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''))) return { ok: false, reason: 'userinfo' };
  if (!policy.allowed_origins.map(normalOrigin).includes(url.origin.toLowerCase())) return { ok: false, reason: 'origin' };
  if (/%2e/i.test(raw) || /\/\.\.?(?:[/?#]|$)/.test(raw) || !policy.prefixes.some((p) => url.pathname.startsWith(p))) return { ok: false, reason: 'path' };
  return { ok: true, url: url.toString() };
}

/* ------------------------------------------------------------------------------------------------ ticket issuance (the pure part) */

export interface IssuanceCase {
  /** Request headers that matter before the controller runs. */
  headers?: { Origin?: string | null };
  /** `scopes` of the bearer's payload; a non-empty list is a scoped (connect) token and may not mint a ticket (SEC 1.4 check 2). */
  bearer_scopes?: readonly string[] | null;
  body: unknown;
}

export type IssuanceOutcome = { status: 201 } | { status: number; code: ErrorCode };

/**
 * SEC 1.4 checks 1 and 2 and the request validation, in that order. Membership and rights (checks 3 and 4) need the tenant database;
 * the fixture cases that depend on them carry `requires: "server"` and are replayed only by the dms-api tests.
 */
export function evaluateIssuance(input: IssuanceCase, policy: LaunchUrlPolicy): IssuanceOutcome {
  const origin = input.headers?.Origin;
  if (typeof origin !== 'string' || !policy.allowed_origins.map(normalOrigin).includes(normalOrigin(origin))) return { status: 403, code: 'FP_ORIGIN_DENIED' };
  if (input.bearer_scopes !== undefined && input.bearer_scopes !== null && input.bearer_scopes.length > 0) return { status: 403, code: 'FP_TICKET_CHANNEL_DENIED' };
  const body = input.body;
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const mode = (body as { mode?: unknown }).mode;
    if (typeof mode === 'string' && (RESERVED_MODES as readonly string[]).includes(mode)) return { status: 422, code: 'MODE_NOT_TICKETED' };
  }
  const parsed = TicketRequestSchema.safeParse(body);
  if (!parsed.success) return { status: 422, code: 'VALIDATION_FAILED' };
  if (!checkLaunchUrl(parsed.data.return_url, policy).ok || !checkLaunchUrl(parsed.data.reconnect_url, policy).ok) return { status: 422, code: 'VALIDATION_FAILED' };
  return { status: 201 };
}

/* ------------------------------------------------------------------------------------------------ fragment grammar (fORM- side) */

export type FragmentResult =
  | { ok: true; ticket: string; api?: string; verifier?: string }
  /** `legacy_descriptor`: a `#fp=` link ("This link is no longer supported. Open the form again from DMS."). */
  | { ok: false; reason: 'missing' | 'legacy_descriptor' | 'malformed' | 'api_not_allowed' };

/**
 * `#fpt=<fpt1_ + 43 b64url>`, plus `&api=<allowlisted base>` only when more than one API base is configured, plus `&fpv=<verifier>`
 * in dev builds (`devOverrides`); production builds ignore `fpv`. Any other key, a repeated key or a malformed ticket is refused
 * before a request is made.
 */
export function parseTicketFragment(hash: string, opts: { apiBases: readonly string[]; devOverrides: boolean }): FragmentResult {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (body === '') return { ok: false, reason: 'missing' };
  const params = new URLSearchParams(body);
  if (params.has('fp')) return { ok: false, reason: 'legacy_descriptor' };
  if (!params.has('fpt')) return { ok: false, reason: 'missing' };
  const keys = [...params.keys()];
  if (keys.some((k) => k !== 'fpt' && k !== 'api' && k !== 'fpv') || new Set(keys).size !== keys.length) return { ok: false, reason: 'malformed' };
  const ticket = params.get('fpt') ?? '';
  if (!TICKET_RE.test(ticket)) return { ok: false, reason: 'malformed' };
  const out: { ok: true; ticket: string; api?: string; verifier?: string } = { ok: true, ticket };
  if (params.has('api')) {
    const api = (params.get('api') ?? '').replace(/\/+$/, '');
    if (opts.apiBases.length <= 1 || !opts.apiBases.map((b) => b.replace(/\/+$/, '')).includes(api)) return { ok: false, reason: 'api_not_allowed' };
    out.api = api;
  }
  if (opts.devOverrides && params.has('fpv')) {
    const verifier = params.get('fpv') ?? '';
    if (!B64URL_43_RE.test(verifier)) return { ok: false, reason: 'malformed' };
    out.verifier = verifier;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ return parameters */

/** The `fp_*` parameters of a return URL's query string, or null when it is not a well-formed return (repeated keys, unknown status, bad ids). */
export function parseReturnParams(search: string): ReturnParams | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const raw: Record<string, string> = {};
  for (const key of ['fp_status', 'fp_master_id', 'fp_record_id', 'fp_code']) {
    const all = params.getAll(key);
    if (all.length > 1) return null;
    if (all.length === 1) raw[key] = all[0] ?? '';
  }
  const parsed = ReturnParamsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------------------------------------------ share link expiry (SEC 6.3) */

export interface ShareExpiryConfig {
  /** `master_share.invite_ttl_days`. */
  invite_ttl_days: number;
  /** `master_share.legacy_public_sunset` as unix seconds, null = legacy public links never expire. */
  legacy_public_sunset: number | null;
  /** `master_share.expiry_grace_until` as unix seconds, null = rollout not started, legacy invites never expire. */
  expiry_grace_until: number | null;
}

export interface ShareLinkState {
  kind: ShareLinkKind;
  token?: string;
  /** Legacy invites: `COALESCE(last_invited_at, created_at)` as unix seconds. */
  invited_at?: number;
  /** Slug links: `master_share_settings.is_public_enabled`. */
  is_public_enabled?: boolean;
}

const DAY = 86_400;

/** What a share read or submit does with a link right now: `ok`, `expired` (410 `LINK_EXPIRED`) or `disabled` (refused as today). */
export function shareLinkOutcome(link: ShareLinkState, now: number, cfg: ShareExpiryConfig): 'ok' | 'expired' | 'disabled' {
  switch (link.kind) {
    case 'slug':
      return link.is_public_enabled === false ? 'disabled' : 'ok';
    case 'public_v2':
    case 'invite_v2': {
      const expiry = shareTokenExpiry(link.token ?? '');
      return expiry === null || now > expiry ? 'expired' : 'ok';
    }
    case 'public_legacy':
      return cfg.legacy_public_sunset !== null && now > cfg.legacy_public_sunset ? 'expired' : 'ok';
    case 'invite_legacy': {
      if (cfg.expiry_grace_until === null || link.invited_at === undefined) return 'ok';
      return now > Math.max(link.invited_at + cfg.invite_ttl_days * DAY, cfg.expiry_grace_until) ? 'expired' : 'ok';
    }
  }
}

/** Which kind of token a string is: v2 (expiry inside), legacy (32 lowercase alphanumerics) or neither (a slug or garbage). */
export function shareTokenShape(token: string): 'v2' | 'legacy' | 'other' {
  if (SHARE_TOKEN_V2_RE.test(token)) return 'v2';
  return SHARE_TOKEN_LEGACY_RE.test(token) ? 'legacy' : 'other';
}
