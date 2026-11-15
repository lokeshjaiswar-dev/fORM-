import type pg from 'pg';

/*
 * `auth_throttle_hit()` counts in fixed windows aligned to the epoch of the DATABASE's clock: a window is
 * `[floor(now / W) * W, + W)`, and a new window starts counting from zero. A test that spends a small budget (five
 * attempts, then expects the sixth to be refused) is therefore only right when no window ends while it runs. With 600
 * second windows a run that crossed a multiple of 600 s of the database's clock saw its count restart in the middle, and
 * the attempt that should have been refused went through: a failure that came and went with the minute the suite
 * happened to start in (unlock.int.test.ts, "counts every attempt per address and form").
 *
 * The windows cannot be frozen from a test: `now()` in the database is not injectable, and the migration of
 * `auth_throttle_hit()` is never edited. What a test can choose is the length of the window it configures (the function
 * takes any length from 1 s to 24 h). So it picks, from the database's own clock, a length whose current window still
 * has plenty of time left. The test then asserts exactly what it asserted before (the same budget, the same refusals);
 * only the boundary it must not cross has moved out of reach, whatever time the run starts at.
 */

/** The longest window `auth_throttle_hit()` accepts, in seconds. */
const LONGEST = 86_400;

/**
 * A window length, in seconds and no longer than a day, whose window that contains `nowEpochSeconds` (aligned to the
 * epoch, as the database aligns it) has at least `room` seconds left. The longest length is tried first, so most of the
 * time the answer is a day; only in the last `room` seconds of a UTC day does it settle for a slightly shorter one.
 */
export function windowWithRoom(nowEpochSeconds: number, room: number): number {
  for (let length = LONGEST; length > room; length--) {
    if (length - (nowEpochSeconds % length) >= room) return length;
  }
  throw new Error(`no throttle window has ${room} seconds left at ${nowEpochSeconds}`);
}

/** One hour: far longer than any file of this suite runs, and a test has 30 seconds. */
const ROOM_SECONDS = 3600;

/** `windowWithRoom` at the database's clock, the one `auth_throttle_hit()` reads. */
export async function throttleWindowSeconds(db: Pick<pg.Pool, 'query'>, room = ROOM_SECONDS): Promise<number> {
  const { rows } = await db.query<{ now: number }>('select extract(epoch from now())::float8 as now');
  return windowWithRoom(rows[0]!.now, room);
}
