import { equalBytes, hmac } from '../modules/auth/crypto.ts';

/*
 * The access token a respondent gets for a password-protected form (WP-1.07, ACC-05): proof that the password was
 * given a moment ago, so the runtime and the submit pipeline need not ask again. Stateless: an HMAC over the claims,
 * keyed from the API secret, so any node can check it and nothing is stored. It carries no personal data.
 *
 * The token proves one thing about one form (`formId`) and one version of it (`versionScope`, the version that was live
 * when the respondent unlocked it, which is the one the page they hold belongs to). It does not prove who the
 * respondent is, and it is not a session.
 */

/** Two hours (architecture §3.3, `POST /f/:slug/unlock`). */
export const ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;

const PREFIX = 'fr1';
const MAX_TOKEN_LENGTH = 512;

export interface AccessScope {
  formId: string;
  /** The version the token is good for (a published version id). */
  versionScope: string;
}

export interface AccessClaims extends AccessScope {
  /** Seconds since the epoch. `iat` lets a later check refuse a token that is older than the form's last password change. */
  iat: number;
  exp: number;
}

const b64 = (data: string | Uint8Array): string => Buffer.from(data).toString('base64url');

/** Its own key, so a token cannot be replayed as any other value the secret signs (IP salts, OAuth state). */
const keyOf = (secret: Uint8Array): Uint8Array => hmac(secret, 'fr:access-token:v1');

const sign = (secret: Uint8Array, payload: string): Uint8Array => hmac(keyOf(secret), `${PREFIX}.${payload}`);

export function issueAccessToken(secret: Uint8Array, scope: AccessScope, now: Date): { accessToken: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ACCESS_TOKEN_TTL_SECONDS;
  const payload = b64(JSON.stringify({ f: scope.formId, v: scope.versionScope, i: iat, e: exp }));
  return { accessToken: `${PREFIX}.${payload}.${b64(sign(secret, payload))}`, expiresAt: new Date(exp * 1000) };
}

/**
 * The claims of a token that is genuine, unexpired and for exactly this form and version; null for anything else, without
 * saying which check failed. The signature is compared in constant time and checked before the payload is read.
 */
export function verifyAccessToken(secret: Uint8Array, token: string, expected: AccessScope, now: Date): AccessClaims | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, payload = '', signature = ''] = parts;
  if (!equalBytes(sign(secret, payload), new Uint8Array(Buffer.from(signature, 'base64url')))) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null) return null;
  const { f, v, i, e } = claims as Record<string, unknown>;
  if (typeof f !== 'string' || typeof v !== 'string' || !Number.isSafeInteger(i) || !Number.isSafeInteger(e)) return null;
  if (f !== expected.formId || v !== expected.versionScope) return null;
  if ((e as number) <= Math.floor(now.getTime() / 1000)) return null;
  return { formId: f, versionScope: v, iat: i as number, exp: e as number };
}
