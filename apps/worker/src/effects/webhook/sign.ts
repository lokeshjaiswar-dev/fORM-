import { createHmac } from 'node:crypto';

/*
 * The signature of a webhook delivery (WP-1.18, INT-01). The receiver proves a request came from fORM and was not changed on
 * the way by recomputing the HMAC; the recipe it follows is `verify-recipe.ts`, quoted verbatim in
 * `docs/platform/webhook-signatures.md`. `sign.test.ts` signs here and verifies there, so the two cannot drift apart.
 */

/** The header that carries the signature: `t=<unix seconds>,v1=<hex>`. */
export const SIGNATURE_HEADER = 'fORM-Signature';
/** The id of this delivery: the same on every retry of it, new for a replay. A receiver may use it to drop a repeat. */
export const DELIVERY_ID_HEADER = 'fORM-Delivery-Id';
/** The event name, e.g. `submission.created`; also in the body. */
export const EVENT_HEADER = 'fORM-Event';

/**
 * The value of the `fORM-Signature` header for `rawBody` sent at `timestampSeconds`: `t=<seconds>,v1=<hex>`, where `v1` is
 * HMAC-SHA256 keyed with the secret over the text `<seconds>.<rawBody>`. The timestamp is inside the signed text, so an old
 * request cannot be sent again with a new time. A retry or a replay signs again with the time of its own attempt.
 *
 * `secret` is the signing secret exactly as the owner was shown it: its bytes are the HMAC key (it is not base64-decoded).
 */
export function signWebhook(secret: Uint8Array | string, rawBody: string, timestampSeconds: number): string {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) throw new RangeError('signWebhook: the timestamp must be whole seconds since 1970');
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.`).update(rawBody).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}
