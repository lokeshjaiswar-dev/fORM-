import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/*
 * The `answersHash` a checker sends back with a decision (WP-2.33) is a keyed token, not the unit's sha256.
 *
 * `submission_reviews.answers_hash` is the plain sha256 of the unit's stored answers (RFC 8785 canonical JSON). Handing that
 * to a caller would let them test guesses offline against answers they may not read: until WP-1.11 a protected field
 * (`compliance.encrypt`, classification `sensitive`) is stored in plain text and only masked on output, but the masked
 * placeholder still says its type, so a yes/no, a radio, a date of birth or an amount can be brute-forced by hashing
 * candidates until one matches the digest. The same holds for a block of the caller's own unit that `own_unit` hides
 * because it is derived from another unit's answers. So the review detail sends `HMAC-SHA256(secret, org | response | unit |
 * round | hash)` instead. Without the server's key a caller cannot compute a token for a guess, and a token for one unit,
 * round or response is no use for another.
 *
 * The contract the builder sees is unchanged: 64 hex digits, read from `units[].answersHash` and echoed in the decision.
 * The decide route turns it back into the row's raw hash and `review_decide()` still compares that under its own lock, so a
 * change between the read and the decision is still `review_stale`.
 */

const LABEL = 'fr-review-answers-token-v1';
const HASH_BYTES = 32;

/** What a token is bound to: the response (in its org), the unit and the round, besides the hash itself. */
export interface AnswersTokenScope {
  orgId: string;
  submissionId: string;
  unitId: string;
  round: number;
}

function mac(secret: Uint8Array, scope: AnswersTokenScope, rawHash: Uint8Array): Buffer {
  // A JSON array is unambiguous whatever the unit id holds, and the label keeps this key apart from every other HMAC made from the secret.
  const message = JSON.stringify([LABEL, scope.orgId, scope.submissionId, scope.unitId, scope.round, Buffer.from(rawHash).toString('hex')]);
  return createHmac('sha256', secret).update(message).digest();
}

/** The token of a unit's current answers: 64 hex digits, the shape of the digest it replaces. */
export function answersHashToken(secret: Uint8Array, scope: AnswersTokenScope, rawHash: Uint8Array): string {
  if (rawHash.byteLength !== HASH_BYTES) throw new TypeError(`rawHash must be a sha256 digest of ${HASH_BYTES} bytes`);
  return mac(secret, scope, rawHash).toString('hex');
}

/**
 * The raw hash a token stands for: the first of `candidates` (the hashes this caller could have been given a token for) whose
 * token is `given`, compared in constant time. Null when none is, whether the token was forged, made for another unit or round,
 * or made for answers that have changed since. Hex is read in either case, as the route's body schema accepts both.
 */
export function rawHashOfToken(secret: Uint8Array, scope: AnswersTokenScope, given: string, candidates: readonly Uint8Array[]): Uint8Array | null {
  const bytes = Buffer.from(given, 'hex');
  // `Buffer.from(…, 'hex')` stops at the first non-hex digit, so a short result is a malformed token, not a prefix to compare.
  if (bytes.byteLength !== HASH_BYTES) return null;
  let found: Uint8Array | null = null;
  for (const candidate of candidates) {
    if (candidate.byteLength !== HASH_BYTES) continue;
    // Every candidate is compared, so the time does not say which one matched.
    if (timingSafeEqual(bytes, mac(secret, scope, candidate)) && found === null) found = candidate;
  }
  return found;
}

/**
 * A hash that is no unit's: what the decide route gives `review_decide()` for a token that matches nothing. The function then
 * makes every other check in its own order (group, two-factor sign-in, open, order) and ends in `review_stale`, so a forged
 * token is answered like a stale one, and a caller who may not decide the unit is still told that and not "stale". Random, so
 * no answers a caller could cause the row to hold have this digest.
 */
export function unmatchableHash(): Uint8Array {
  return new Uint8Array(randomBytes(HASH_BYTES));
}
