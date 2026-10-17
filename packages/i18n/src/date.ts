/** Mirrors the schema's `DATE_PATTERNS`; i18n sits beside schema in L0 and cannot import it. */
export const SUPPORTED_DATE_PATTERNS = ['DD-MM-YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'D MMM YYYY', 'MMMM D, YYYY'] as const;
export type DatePattern = (typeof SUPPORTED_DATE_PATTERNS)[number];
export type DateSeparator = '-' | '/' | '.';
export type HourCycle = 'h12' | 'h23';

export interface DateNames {
  monthsShort: readonly string[];
  monthsLong: readonly string[];
  am: string;
  pm: string;
}

/** en-IN names, fixed here so output never depends on the host's CLDR version (e.g. `Sep` vs `Sept`). */
export const EN_DATE_NAMES: DateNames = {
  monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  monthsLong: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  am: 'am',
  pm: 'pm',
};

export interface DateFormatOptions {
  /** Replaces the separator of the numeric patterns (`DateConfig.separator`). */
  separator?: DateSeparator;
  names?: DateNames;
}

interface Ymd {
  year: string;
  month: number;
  day: number;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseIsoDate(value: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = match[1] ?? '';
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(Number(year), month)) return null;
  return { year, month, day };
}

function parseIsoTime(value: string): { hour: number; minute: string } | null {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute: match[2] ?? '' };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Formats an `IsoDate` (`YYYY-MM-DD`) with a schema `DatePattern`. Invalid input gives `''`. */
export function formatDate(value: string, pattern: DatePattern, options: DateFormatOptions = {}): string {
  const date = parseIsoDate(value);
  if (!date) return '';
  const names = options.names ?? EN_DATE_NAMES;
  const dd = pad2(date.day);
  const mm = pad2(date.month);
  const { year } = date;
  switch (pattern) {
    case 'DD-MM-YYYY':
      return [dd, mm, year].join(options.separator ?? '-');
    case 'DD/MM/YYYY':
      return [dd, mm, year].join(options.separator ?? '/');
    case 'MM/DD/YYYY':
      return [mm, dd, year].join(options.separator ?? '/');
    case 'YYYY-MM-DD':
      return [year, mm, dd].join(options.separator ?? '-');
    case 'D MMM YYYY':
      return `${date.day} ${names.monthsShort[date.month - 1] ?? ''} ${year}`;
    case 'MMMM D, YYYY':
      return `${names.monthsLong[date.month - 1] ?? ''} ${date.day}, ${year}`;
  }
}

/** Formats an `IsoTime` (`HH:mm` wall clock): `h23` → `14:05`, `h12` → `2:05 pm`. Invalid input gives `''`. */
export function formatTime(value: string, hourCycle: HourCycle, names: DateNames = EN_DATE_NAMES): string {
  const time = parseIsoTime(value);
  if (!time) return '';
  if (hourCycle === 'h23') return `${pad2(time.hour)}:${time.minute}`;
  const hour = time.hour % 12 === 0 ? 12 : time.hour % 12;
  return `${hour}:${time.minute} ${time.hour < 12 ? names.am : names.pm}`;
}

/**
 * Formats an `IsoLocalDateTime` (`YYYY-MM-DDTHH:mm`) as wall-clock time; converting from an
 * instant into the form's time zone is the caller's job. Invalid input gives `''`.
 */
export function formatDateTime(
  value: string,
  pattern: DatePattern,
  hourCycle: HourCycle,
  options: DateFormatOptions = {},
): string {
  const [date = '', time = '', extra] = value.split('T');
  if (extra !== undefined) return '';
  const datePart = formatDate(date, pattern, options);
  const timePart = formatTime(time, hourCycle, options.names);
  return datePart && timePart ? `${datePart}, ${timePart}` : '';
}
