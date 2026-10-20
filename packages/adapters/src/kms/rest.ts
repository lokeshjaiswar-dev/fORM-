import { createSign } from 'node:crypto';
import { PortError, type EgressGuard } from '@form/ports';
import { egressHttp } from '../egress/http.ts';

export interface RestOptions {
  egress: EgressGuard;
  /** PEM CA bundle for a private CA (Vault behind an internal TLS certificate). */
  ca?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface RestReply {
  status: number;
  body: Record<string, unknown>;
}

/** One JSON call to a KMS REST API through the egress guard. A body that is not a JSON object → PortError('unavailable'). */
export async function restJson(
  o: RestOptions,
  url: URL,
  r: { method: 'GET' | 'POST' | 'PUT'; headers?: Record<string, string>; json?: unknown; form?: Record<string, string> },
): Promise<RestReply> {
  const body = r.json !== undefined ? JSON.stringify(r.json) : r.form ? new URLSearchParams(r.form).toString() : undefined;
  const res = await egressHttp(o.egress, url, {
    method: r.method,
    headers: {
      accept: 'application/json',
      ...(r.json !== undefined ? { 'content-type': 'application/json' } : r.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...r.headers,
    },
    ...(body !== undefined ? { body } : {}),
    timeoutMs: o.timeoutMs ?? 10_000,
    maxResponseBytes: 256 * 1024,
    ...(o.ca ? { ca: o.ca } : {}),
  });
  if (res.body.byteLength === 0) return { status: res.status, body: {} };
  const parsed = res.json();
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new PortError('unavailable', `${url.host} answered ${res.status} without a JSON object`);
  return { status: res.status, body: parsed as Record<string, unknown> };
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** An OAuth access token, cached until shortly before it expires. `invalidate` drops it after a 401. */
export interface TokenSource {
  token(): Promise<string>;
  invalidate(): void;
}

function cachedTokens(fetchToken: () => Promise<{ token: string; expiresInSec: number }>, now: () => number): TokenSource {
  let cached: { token: string; until: number } | undefined;
  let pending: Promise<string> | undefined;
  return {
    async token() {
      if (cached && cached.until > now()) return cached.token;
      pending ??= fetchToken()
        .then(({ token, expiresInSec }) => {
          cached = { token, until: now() + Math.max(0, expiresInSec - 60) * 1000 };
          return token;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

function tokenReply(reply: RestReply, who: string): { token: string; expiresInSec: number } {
  const token = str(reply.body.access_token);
  if (reply.status !== 200 || !token) throw new PortError('unavailable', `${who} token request failed (${reply.status}${str(reply.body.error) ? `: ${String(reply.body.error)}` : ''})`);
  const expires = Number(reply.body.expires_in);
  return { token, expiresInSec: Number.isFinite(expires) && expires > 0 ? expires : 300 };
}

/** The fields of a Google service-account key file the token exchange needs. */
export interface GcpServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function parseGcpServiceAccount(text: string): GcpServiceAccount {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new PortError('invalid_argument', 'the GCP credentials file is not JSON');
  }
  const email = str(v.client_email);
  const key = str(v.private_key);
  if (v.type !== 'service_account' || !email || !key) throw new PortError('invalid_argument', 'the GCP credentials file is not a service-account key');
  const uri = str(v.token_uri);
  return { client_email: email, private_key: key, ...(uri ? { token_uri: uri } : {}) };
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** A service-account JWT bearer grant (RFC 7523) for the Cloud KMS scope. */
export function gcpServiceAccountTokens(o: RestOptions & { credentials: GcpServiceAccount; now?: () => number }): TokenSource {
  const now = o.now ?? Date.now;
  const tokenUri = o.credentials.token_uri ?? 'https://oauth2.googleapis.com/token';
  return cachedTokens(async () => {
    const iat = Math.floor(now() / 1000);
    const claims = { iss: o.credentials.client_email, scope: 'https://www.googleapis.com/auth/cloudkms', aud: tokenUri, iat, exp: iat + 3600 };
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(o.credentials.private_key);
    const reply = await restJson(o, new URL(tokenUri), {
      method: 'POST',
      form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` },
    });
    return tokenReply(reply, 'GCP');
  }, now);
}

/** Microsoft Entra client credentials for Key Vault. */
export function azureClientCredentialTokens(
  o: RestOptions & { tenantId: string; clientId: string; clientSecret: string; authorityUrl?: string; now?: () => number },
): TokenSource {
  const authority = (o.authorityUrl ?? 'https://login.microsoftonline.com').replace(/\/+$/, '');
  return cachedTokens(async () => {
    const reply = await restJson(o, new URL(`${authority}/${encodeURIComponent(o.tenantId)}/oauth2/v2.0/token`), {
      method: 'POST',
      form: { grant_type: 'client_credentials', client_id: o.clientId, client_secret: o.clientSecret, scope: 'https://vault.azure.net/.default' },
    });
    return tokenReply(reply, 'Azure');
  }, o.now ?? Date.now);
}
