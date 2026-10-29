import { createHmac, randomBytes } from 'node:crypto';
import { base32Encode } from './crypto.ts';

/** RFC 6238 TOTP as authenticator apps expect it: HMAC-SHA1, 6 digits, 30-second steps, one step of drift either way. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
const DRIFT_STEPS = 1;

export function newTotpSecret(): Uint8Array {
  return new Uint8Array(randomBytes(20));
}

export const totpStep = (now: Date) => Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);

/** RFC 4226 HOTP of one counter value. */
export function hotp(secret: Uint8Array, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export const TOTP_CODE = /^\d{6}$/;

/**
 * The step a code matches, or null. A step at or before `lastStep` (the last code accepted for the user) never
 * matches, so a code cannot be used twice. Every candidate step is computed, so timing does not tell which matched.
 */
export function verifyTotp(secret: Uint8Array, code: string, now: Date, lastStep: number | null): number | null {
  const normalised = code.replace(/\s/g, '');
  if (!TOTP_CODE.test(normalised)) return null;
  const current = totpStep(now);
  let matched: number | null = null;
  for (let s = current - DRIFT_STEPS; s <= current + DRIFT_STEPS; s++) {
    if (hotp(secret, s) === normalised && (lastStep === null || s > lastStep) && matched === null) matched = s;
  }
  return matched;
}

/** `otpauth://` URI for authenticator apps (and the enrolment QR code). */
export function otpauthUri(o: { issuer: string; account: string; secret: Uint8Array }): string {
  const label = encodeURIComponent(`${o.issuer}:${o.account}`);
  const params = new URLSearchParams({ secret: base32Encode(o.secret), issuer: o.issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
