import { createHmac, timingSafeEqual } from 'node:crypto';

/** A request older or newer than this many seconds is refused, so a captured request cannot be sent again later. */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * True when `signatureHeader` (the `fORM-Signature` header) is a valid signature of `rawBody` made with `secret`, and the
 * request is no more than five minutes old.
 *
 * `rawBody` must be the bytes exactly as they arrived, before any JSON parsing: parsing and printing again changes
 * spaces and key order, and the signature no longer matches. `secret` is the signing secret as it was shown to you
 * (do not decode it).
 */
export function verifyWebhook(rawBody: string | Uint8Array, signatureHeader: string | undefined, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!signatureHeader) return false;

  // The header is `t=<unix seconds>,v1=<hex>`; it may hold several `v1` entries (during a secret change).
  let timestamp: string | undefined;
  const candidates: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === 't') timestamp = value;
    if (name === 'v1') candidates.push(value);
  }
  if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp)) return false;

  // Refuse a request outside the tolerance, in either direction.
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  // The signed text is the timestamp, a dot, and the raw body.
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();

  // Compare in constant time, so the time taken does not tell an attacker how many bytes were right.
  return candidates.some((hex) => /^[0-9a-f]{64}$/i.test(hex) && timingSafeEqual(Buffer.from(hex, 'hex'), expected));
}
