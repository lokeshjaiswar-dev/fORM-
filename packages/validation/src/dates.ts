import type { DateBound, IsoDate } from '@form/schema';

/* Calendar arithmetic on `YYYY-MM-DD` strings with integers only: no Date, no host clock or time zone. */

interface Ymd { y: number; m: number; d: number }

const parse = (date: string): Ymd => {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return { y, m, d };
};

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const format = ({ y, m, d }: Ymd): IsoDate => `${y < 0 ? '-' : ''}${pad(Math.abs(y), 4)}-${pad(m, 2)}-${pad(d, 2)}` as IsoDate;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y: number, m: number) => (m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);

/** Days since 1970-01-01 (proleptic Gregorian). */
function toDays({ y, m, d }: Ymd): number {
  const year = m <= 2 ? y - 1 : y;
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

function fromDays(days: number): Ymd {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

export const addDays = (date: string, days: number): IsoDate => format(fromDays(toDays(parse(date)) + days));

/** Adds whole months, clamping to the last day of the target month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, months: number): IsoDate {
  const { y, m, d } = parse(date);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return format({ y: year, m: month, d: Math.min(d, daysIn(year, month)) });
}

/** A relative bound from `today` (the date of `meta.now` in the form's time zone). */
export function relativeDate(today: IsoDate, bound: Extract<DateBound, { kind: 'relative' }>): IsoDate {
  switch (bound.unit) {
    case 'day':
      return addDays(today, bound.offset);
    case 'week':
      return addDays(today, bound.offset * 7);
    case 'month':
      return addMonths(today, bound.offset);
    case 'year':
      return addMonths(today, bound.offset * 12);
  }
}

/** Completed years from `birth` to `today`; a 29 February birthday completes a year on 1 March in common years. */
export function ageOn(birth: IsoDate, today: IsoDate): number {
  const b = parse(birth);
  const t = parse(today);
  const before = t.m < b.m || (t.m === b.m && t.d < b.d);
  return t.y - b.y - (before ? 1 : 0);
}
