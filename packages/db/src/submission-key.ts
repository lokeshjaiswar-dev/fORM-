import { randomBytes } from 'node:crypto';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { submissions } from './schema/submissions.ts';

/** A UUID of version 7 and the RFC 9562 variant: the only ids `uuid_v7_ts()` accepts, so the only ones a submission can have. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7.test(value);
}

/** The first 48 bits of a UUIDv7 are unix milliseconds, so the largest moment an id can name is 2^48 - 1 ms. */
const MAX_MS = 2 ** 48 - 1;

/**
 * A new UUIDv7 for the moment `at`: 48 bits of unix milliseconds, then random bits (version 7, variant 10). The server
 * makes every submission id (CONTRIBUTING §5, rule 2), and `submissions.received_at` must equal the moment inside it.
 * `random` is the source of the 16 random bytes (a test passes a fixed one).
 */
export function uuidV7(at: Date, random: (size: number) => Uint8Array = randomBytes): string {
  const ms = at.getTime();
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_MS) throw new RangeError('uuidV7: the time must be between 1970 and the year 10889');
  const b = Buffer.from(random(16));
  b.writeUIntBE(ms, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The moment inside a UUIDv7 (what `uuid_v7_ts()` returns in the database), or null when `id` is not a UUIDv7. */
export function uuidV7Time(id: string): Date | null {
  if (!isUuidV7(id)) return null;
  return new Date(Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16));
}

/** A new submission's key: its id, and the `received_at` the CHECK demands, which is the moment inside the id. */
export function newSubmissionKey(now: Date): { id: string; receivedAt: Date } {
  const id = uuidV7(now);
  return { id, receivedAt: uuidV7Time(id)! };
}

/**
 * The WHERE condition for one submission by id: the id and the partition key it implies (`received_at = uuid_v7_ts(id)`),
 * so the planner reads one partition and not all of them. For an id that is not a UUIDv7 (a made-up one in a URL), no
 * submission can have it, and the condition is `false`: the database is never asked to take the timestamp of a v4 id,
 * which it refuses with an error instead of an empty result.
 */
export function submissionKey(id: string): SQL {
  const receivedAt = uuidV7Time(id);
  if (!receivedAt) return sql`false`;
  return and(eq(submissions.id, id), eq(submissions.receivedAt, receivedAt))!;
}
