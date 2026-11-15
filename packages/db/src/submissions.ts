import { sql } from 'drizzle-orm';
import type { Executor } from './client.ts';
import type { SubmissionStatus } from './schema/submissions.ts';

/** What the submit transaction writes of a response: exactly the columns fr_app has an INSERT grant on (migration 0021). */
export interface NewSubmission {
  /** A UUIDv7 (`newSubmissionKey`). */
  id: string;
  /** The moment inside `id`: the table's CHECK refuses any other. */
  receivedAt: Date;
  orgId: string;
  formId: string;
  /** The version the answers were validated against; it must belong to `orgId` and `formId`. */
  formVersionId: string;
  /** sha256 of that version's definition, as 32 bytes. */
  definitionHash: Uint8Array;
  /** 0 (`ANSWER_CODEC_PLAIN`) for plain jsonb answers. */
  answerCodecVersion: number;
  status: SubmissionStatus;
  answers: Record<string, unknown>;
  computed: Record<string, unknown>;
  meta: Record<string, unknown>;
  /** Blind indexes of the principal-identifier fields (WP-1.11). */
  principalBidx?: readonly Uint8Array[] | null | undefined;
}

/**
 * Inserts a response. Use this, not `tx.insert(submissions)`: Drizzle lists every column of the table in an INSERT (with
 * `default` for the ones it was not given), and fr_app may insert only the columns above; the retention, hold, inbox and
 * `seq` columns are not its to name. Run it inside the respondent's tenant transaction; it returns nothing, because a
 * respondent cannot read the row back until a verified token names it (RETURNING would be refused).
 *
 * The form's counters and the hold on the files the answers name are kept by a trigger on this INSERT, and `delete_after`
 * is filled by another, so none of them is written here.
 */
export async function recordSubmission(db: Executor, row: NewSubmission): Promise<void> {
  // An array literal of hex bytea elements, `{"\\x0102","\\x0304"}`: drizzle would expand a JS array into a row of
  // parameters, and a driver-side array of Buffers is not worth depending on for a column nothing reads back yet.
  const principal = row.principalBidx ? `{${row.principalBidx.map((b) => `"\\\\x${Buffer.from(b).toString('hex')}"`).join(',')}}` : null;
  await db.execute(sql`insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version,
      status, answers, computed, meta, principal_bidx)
    values (${row.id}, ${row.receivedAt.toISOString()}::timestamptz, ${row.orgId}, ${row.formId}, ${row.formVersionId}, ${Buffer.from(row.definitionHash)},
      ${row.answerCodecVersion}, ${row.status}, ${JSON.stringify(row.answers)}::jsonb, ${JSON.stringify(row.computed)}::jsonb,
      ${JSON.stringify(row.meta)}::jsonb, ${principal}::bytea[])`);
}
