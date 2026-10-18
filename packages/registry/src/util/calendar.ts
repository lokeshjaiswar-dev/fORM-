import type { Weekday } from '@form/schema';

const MONTH_OFFSET = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4] as const;

/** Day of the week (0 = Sunday) of a `YYYY-MM-DD` date, without the host clock or time zone. */
export function weekdayOf(date: string): Weekday {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  const year = m < 3 ? y - 1 : y;
  const day = (year + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400) + (MONTH_OFFSET[m - 1] ?? 0) + d) % 7;
  return day as Weekday;
}

/** Minutes since midnight of an `HH:mm` wall-clock time. */
export function minutesOf(time: string): number {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return h * 60 + m;
}
