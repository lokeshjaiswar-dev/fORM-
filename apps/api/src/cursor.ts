import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed keyset cursors for list endpoints (the forms list; the submissions grid reuses this file).
 *
 * A page of a list ends at the last row it showed, and the next page starts after that row. The cursor is that row's
 * position: the sort key and the id, which together are unique, so no row is skipped or shown twice while the list
 * changes underneath. It is signed so a client cannot invent a position: a forged or edited cursor is refused, not
 * interpreted. The signature also covers a `scope` (the org, the sort, the filters), so a cursor from one list cannot
 * be replayed against another.
 *
 * Format: `c1.<base64url JSON array of values>.<base64url HMAC-SHA-256>`. The values are readable by whoever holds the
 * cursor (they are the last row's sort key and id), so never put a value in one that the holder may not see.
 */

export type CursorValue = string | number | null;

const PREFIX = 'c1';
/** A cursor holds a sort key and an id; anything longer is not one of ours. */
const MAX_VALUES = 8;
/** A title is at most 500 characters; the key may be that, in UTF-8, plus the id and the signature. */
export const MAX_CURSOR_LENGTH = 4096;

function mac(secret: Uint8Array, scope: string, payload: string): Buffer {
  // One label per purpose, so the key of a cursor is not the key of any other HMAC the API makes from the same secret.
  return createHmac('sha256', secret).update('fr-cursor-v1\0').update(scope).update('\0').update(payload).digest();
}

/** The cursor for the position `values` (sort key first, id last) in the list named by `scope`. */
export function signCursor(secret: Uint8Array, scope: string, values: readonly CursorValue[]): string {
  const payload = Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
  return `${PREFIX}.${payload}.${mac(secret, scope, payload).toString('base64url')}`;
}

/**
 * The values a cursor holds, or null when it is not a cursor this API signed for this `scope`: edited, truncated,
 * made with another key, or taken from another list. The caller answers 400; it must not fall back to the first page,
 * which would hide a client bug as a loop.
 */
export function readCursor(secret: Uint8Array, scope: string, token: string): CursorValue[] | null {
  if (token.length > MAX_CURSOR_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, payload, signature] = parts as [string, string, string];
  const given = Buffer.from(signature, 'base64url');
  const expected = mac(secret, scope, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let values: unknown;
  try {
    values = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_VALUES) return null;
  if (!values.every((v) => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) return null;
  return values as CursorValue[];
}
