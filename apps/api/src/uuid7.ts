import { randomBytes } from 'node:crypto';

/**
 * A UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then random bits. Ids the server makes are v7, not v4, so rows
 * written together sit together in the primary-key index and `uuid_v7_ts()` can read the creation time back. The clock
 * is a parameter, so a test can pin it.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(nowMs, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
