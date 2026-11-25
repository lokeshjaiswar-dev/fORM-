import { eq } from 'drizzle-orm';
import { secretEnc, secretPublicColumns, secrets, withTenant, type Db } from '@form/db';
import { buildUpstreamRequest, parseApiBody } from '@form/logic';
import { ApiAuthSchema, type ApiAuth, type ApiRequestConfig } from '@form/schema';
import { isPortError, type OrgSecrets } from '@form/ports';

/**
 * The one place the API calls a third-party API on behalf of a form (contract section 3). It builds the request from the
 * stored config plus one value, attaches the org credential only to the host that credential is bound to (https, exact
 * host and port), sends it through the tenant egress guard (pinned address, no redirect, 5 s, 1 MiB) and parses the
 * answer. Every failure is one `UpstreamError`, whose `reason` and `host` go to the server log; the respondent only
 * ever hears the one fixed REMOTE_UPSTREAM_FAILED, so the proxy is no DNS, host or path oracle.
 */

export const UPSTREAM_TIMEOUT_MS = 5000;
export const UPSTREAM_MAX_BYTES = 1024 * 1024;
export const UPSTREAM_USER_AGENT = 'fORM-lookup/1';

/** `tenantHttp` of `main.ts`: `(url, r) => egressHttp(tenantEgress, url, r)`. A refused target is `PortError('egress_denied')`. */
export interface UpstreamHttpRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
}
export type TenantHttp = (url: URL, request: UpstreamHttpRequest) => Promise<{ status: number; text(): string }>;

export type UpstreamFailure =
  | 'bad_url' | 'egress_denied' | 'unavailable' | 'status' | 'unparsable'
  | 'credential_missing' | 'credential_open' | 'credential_host' | 'credential_https' | 'credential_kind';

export class UpstreamError extends Error {
  readonly reason: UpstreamFailure;
  readonly host: string | null;

  constructor(reason: UpstreamFailure, host: string | null) {
    super(`upstream ${reason}`);
    this.reason = reason;
    this.host = host;
  }
}

export interface UpstreamDeps {
  db: Db;
  tenantHttp: TenantHttp;
  orgSecrets?: OrgSecrets | undefined;
}

/** Header names an api_key credential may never use (they would let a credential rewrite the request's framing or identity). */
export const API_KEY_HEADER = /^[A-Za-z0-9-]{1,64}$/;
const REFUSED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'cookie', 'set-cookie', 'forwarded']);
export function isAllowedApiKeyHeader(name: string): boolean {
  const n = name.toLowerCase();
  return API_KEY_HEADER.test(name) && !REFUSED_HEADERS.has(n) && !n.startsWith('proxy-') && !n.startsWith('x-forwarded-');
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** `host[:port]` of a URL as an credential records it: lower case, the scheme's default port dropped (`URL.host` does that). */
export const hostOf = (url: URL): string => url.host.toLowerCase();

function headersFor(auth: ApiAuth): Record<string, string> {
  switch (auth.type) {
    case 'bearer':
      return { authorization: `Bearer ${auth.token}` };
    case 'basic':
      return { authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` };
    case 'api_key':
      if (!isAllowedApiKeyHeader(auth.header)) throw new UpstreamError('credential_open', null);
      return { [auth.header.toLowerCase()]: auth.value };
  }
}

/**
 * The headers the org credential `secretId` adds to a request to `url`. Fails before anything is sent when the credential
 * is not an api_credential of this org, when the URL is not https, or when its host and port are not the ones the credential
 * is bound to: an author with `forms.edit` may name a credential but may never point it at a server of their own.
 */
export async function credentialHeaders(deps: UpstreamDeps, orgId: string, secretId: string, url: URL): Promise<Record<string, string>> {
  const host = hostOf(url);
  if (!deps.orgSecrets) throw new UpstreamError('credential_open', host);
  if (!UUID.test(secretId)) throw new UpstreamError('credential_missing', host);
  // The row is read as a system job of the form's own org (RLS: another org's secret is not there), and the sealed value
  // leaves the transaction before the key service is called.
  const found = await withTenant(deps.db, { orgId, actor: 'system', requestId: `api-credential:${orgId}`, perms: [], readOnly: true }, async (tx) => {
    const [row] = await tx.select(secretPublicColumns).from(secrets).where(eq(secrets.id, secretId)).limit(1);
    if (!row) return { kind: 'missing' } as const;
    if (row.kind !== 'api_credential') return { kind: 'wrong_kind' } as const;
    return { kind: 'ok', meta: row.meta, enc: await secretEnc(tx, secretId) } as const;
  });
  if (found.kind === 'missing') throw new UpstreamError('credential_missing', host);
  if (found.kind === 'wrong_kind') throw new UpstreamError('credential_kind', host);
  if (url.protocol !== 'https:') throw new UpstreamError('credential_https', host);
  if (typeof found.meta['host'] !== 'string' || found.meta['host'].toLowerCase() !== host) throw new UpstreamError('credential_host', host);
  if (!found.enc) throw new UpstreamError('credential_missing', host);
  try {
    const plain = await deps.orgSecrets.open({ orgId, secretId, kind: 'api_credential' }, found.enc);
    const auth = ApiAuthSchema.parse(JSON.parse(new TextDecoder().decode(plain)));
    return headersFor(auth);
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError('credential_open', host);
  }
}

/**
 * Calls the upstream API of `config` with one respondent value and returns its parsed body. `extra` is the search term
 * (a lookup, under its `searchParam`) or the field's value (under the field key); nothing else of the respondent's request
 * is forwarded: no header, no cookie, no address.
 */
export async function callUpstream(
  deps: UpstreamDeps,
  o: { orgId: string; config: ApiRequestConfig; extra?: { key: string; value: unknown } | undefined; /** A check whose 2xx answer has no body passes. */ allowEmpty?: boolean },
): Promise<{ data: unknown; status: number }> {
  let described: ReturnType<typeof buildUpstreamRequest>;
  let url: URL;
  try {
    described = buildUpstreamRequest(o.config, o.extra);
    url = new URL(described.url);
  } catch {
    throw new UpstreamError('bad_url', null);
  }
  const host = hostOf(url);
  const auth = o.config.credentialRef ? await credentialHeaders(deps, o.orgId, o.config.credentialRef.secretId, url) : {};
  let res: { status: number; text(): string };
  try {
    res = await deps.tenantHttp(url, {
      method: described.method,
      // The credential goes last of the configured headers but never replaces the framing ones (it cannot name them).
      headers: { ...described.headers, 'user-agent': UPSTREAM_USER_AGENT, ...auth },
      ...(described.body !== undefined ? { body: described.body } : {}),
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      maxResponseBytes: UPSTREAM_MAX_BYTES,
    });
  } catch (err) {
    throw new UpstreamError(isPortError(err, 'egress_denied') ? 'egress_denied' : 'unavailable', host);
  }
  if (res.status < 200 || res.status >= 300) throw new UpstreamError('status', host);
  const text = res.text();
  if (o.allowEmpty && text.trim() === '') return { data: undefined, status: res.status };
  const parsed = parseApiBody(text, o.config.parser ?? 'json');
  if (parsed.data === undefined) throw new UpstreamError('unparsable', host);
  return { data: parsed.data, status: res.status };
}
