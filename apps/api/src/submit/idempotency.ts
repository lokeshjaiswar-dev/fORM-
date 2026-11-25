import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { submissionIdempotency, type Tx } from '@form/db';
import { canonicalJson } from '@form/schema';

/**
 * Idempotent submits (architecture §2.5 step 3, §3.4). A client that did not see the response to its POST (a dropped
 * connection, a double tap) sends it again with the same `Idempotency-Key`; the second request must give the first's
 * answer and must not store or count anything twice. One row of `submission_idempotency` per (org, form, key) holds
 * what the first request returned, and the hash of what it sent, so a key that comes back with different answers (a
 * client bug, or someone guessing at keys) is told apart from a retry and refused.
 */

/** How long a key is remembered (the row's `expires_at`; a sweep deletes it after). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * What the first request returned: ids only, never an answer (the column is `response jsonb`). `held` is there when the
 * response was kept for a checker (`pending_review`): a replay must tell the respondent the same thing, and a respondent
 * cannot read the review rows to find out later. Rows are never edited, so it is known when the key is claimed.
 */
export interface StoredResult {
  submissionId: string;
  endingId: string;
  held?: 'pending_review';
  /**
   * The reference numbers the respondent's ending shows (`issuedForEnding`): the first of the `unique_id` fields marked
   * `showOnEnding`, and every number by block id that the ending shows or pipes. Stored with the key, so a replay gives
   * the same numbers (the row is never edited, which is why the numbers are taken before the key is claimed).
   */
  uniqueId?: string;
  uniqueIds?: Record<string, string>;
}

export interface StoredIdempotency {
  requestHash: Buffer;
  result: StoredResult;
}

/**
 * The 32-byte digest that tells a retry from a different request: sha256 of the canonical JSON (sorted keys, so the
 * order a client writes them in does not matter) of what decides what is stored: the version, the language, the
 * answers and the page-view details. The display rows (`fields`) are left out, because the server ignores them.
 */
export function hashRequest(request: { formVersionId: string; locale: string; answers: unknown; client: unknown }): Buffer {
  return createHash('sha256').update(canonicalJson({ v: request.formVersionId, l: request.locale, a: request.answers, c: request.client ?? null })).digest();
}

function parseResult(response: Record<string, unknown>): StoredResult {
  // Written by `claimIdempotency` below and by nothing else; a row that does not parse is a defect to see, not to hide.
  const { submissionId, endingId, held, uniqueId, uniqueIds } = response;
  const bad = () => new Error('submission_idempotency.response is not a stored result');
  if (typeof submissionId !== 'string' || typeof endingId !== 'string') throw bad();
  if (held !== undefined && held !== 'pending_review') throw bad();
  if (uniqueId !== undefined && typeof uniqueId !== 'string') throw bad();
  if (uniqueIds !== undefined && (typeof uniqueIds !== 'object' || uniqueIds === null || Object.values(uniqueIds).some((v) => typeof v !== 'string'))) throw bad();
  return {
    submissionId,
    endingId,
    ...(held === undefined ? {} : { held }),
    ...(uniqueId === undefined ? {} : { uniqueId }),
    ...(uniqueIds === undefined ? {} : { uniqueIds: uniqueIds as Record<string, string> }),
  };
}

/** The row of a key, or null. The org is the transaction's (RLS); the form is the one the slug resolved to. */
export async function findIdempotent(tx: Tx, formId: string, key: string): Promise<StoredIdempotency | null> {
  const [row] = await tx
    .select({ requestHash: submissionIdempotency.requestHash, response: submissionIdempotency.response })
    .from(submissionIdempotency)
    .where(and(eq(submissionIdempotency.formId, formId), eq(submissionIdempotency.key, key)))
    .limit(1);
  return row ? { requestHash: Buffer.from(row.requestHash), result: parseResult(row.response) } : null;
}

export interface Claim {
  orgId: string;
  formId: string;
  key: string;
  receivedAt: Date;
  requestHash: Buffer;
  /** What a replay of this request will be given. */
  result: StoredResult;
}

/**
 * The first statement of the submit transaction: `INSERT ... ON CONFLICT DO NOTHING RETURNING`. A returned row means this
 * request owns the key and goes on to store its answers. No row means another request already holds it (finished, or
 * still in its transaction: the INSERT waits for that one to commit or roll back, so a retry that arrives while the first
 * is in flight is held, and gets its result or takes the key if it rolled back); the stored row is read and returned
 * for the caller to compare against its own hash.
 */
export async function claimIdempotency(tx: Tx, claim: Claim): Promise<{ owned: true } | { owned: false; stored: StoredIdempotency }> {
  const inserted = await tx
    .insert(submissionIdempotency)
    .values({
      orgId: claim.orgId,
      formId: claim.formId,
      key: claim.key,
      submissionId: claim.result.submissionId,
      receivedAt: claim.receivedAt,
      requestHash: claim.requestHash,
      response: { ...claim.result },
      expiresAt: new Date(claim.receivedAt.getTime() + IDEMPOTENCY_TTL_MS),
    })
    .onConflictDoNothing()
    .returning({ key: submissionIdempotency.key });
  if (inserted.length > 0) return { owned: true };
  const stored = await findIdempotent(tx, claim.formId, claim.key);
  // The row was there a statement ago and only a system job deletes rows; if the sweep ran in between, the next retry takes the key.
  if (!stored) throw new Error('submission_idempotency row vanished between the conflict and the read');
  return { owned: false, stored };
}
