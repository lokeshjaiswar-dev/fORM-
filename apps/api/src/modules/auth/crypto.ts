import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes, base64url: session tokens, email-link tokens, MFA tickets, OAuth state. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(data: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export function hmac(key: Uint8Array, data: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(data).digest());
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** The store's lookup key of an opaque token: SHA-256 of its text. A token that is not base64url never matches. */
export function tokenHash(token: string): Uint8Array {
  return sha256(token);
}

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * `HMAC(daily_salt, ip)` with the salt derived from the auth secret and the UTC day (CMP-11): rate-limit keys and
 * audit `actorIpHash` never hold the address, and yesterday's hashes cannot be joined with today's.
 */
export function ipHash(secret: Uint8Array, ip: string, now: Date): Uint8Array {
  const salt = hmac(secret, `fr:ip-salt:v1:${now.toISOString().slice(0, 10)}`);
  return hmac(salt, ip).slice(0, 16);
}

/** A rate-limit key that is not the plain address. */
export function accountKey(secret: Uint8Array, emailNorm: string): Uint8Array {
  return hmac(secret, `fr:account:v1:${emailNorm}`).slice(0, 16);
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding (TOTP secrets in authenticator apps). */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i === -1) throw new TypeError('base32: invalid character');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}
