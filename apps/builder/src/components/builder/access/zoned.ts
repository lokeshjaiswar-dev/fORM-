/*
 * Wall-clock times in a named time zone, as instants. The access panel shows open and close dates in the org's time zone
 * (an author in Mumbai types 18:00 and means 18:00 there, whatever zone this browser is set to), but the API stores and
 * compares instants, so what is sent is always UTC. Plain Intl arithmetic: no date library, and the same two-pass
 * correction the API's weekly-hours check uses across a clock change.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, f);
  }
  return f;
}

/** A time zone Intl knows (`Asia/Kolkata`); anything else would throw in every call below. */
export function isKnownZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The calendar and clock fields of `timeZone` at the instant `at`. */
function fieldsAt(timeZone: string, at: Date): Record<string, number> {
  const p: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(at)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return p;
}

/** The UTC offset of `timeZone` at the instant `at`, in milliseconds (positive east of Greenwich). */
function offsetAt(timeZone: string, at: Date): number {
  const p = fieldsAt(timeZone, at);
  const wall = Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']! % 24, p['minute']!, p['second']!);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * The instant (`2026-12-31T12:30:00.000Z`) at which the wall clock of `timeZone` reads `local` (`2026-12-31T18:00`, what
 * a `datetime-local` input holds). Null for a value that is not a real date and time, or a zone Intl does not know.
 */
export function zonedToInstant(local: string, timeZone: string): string | null {
  const m = LOCAL.exec(local);
  if (!m || !isKnownZone(timeZone)) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wall);
  // Date.UTC rolls 31 February into March: a date that did not survive the round trip was not a date.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi) return null;
  // The offset at the guess may differ from the offset at the answer across a clock change: correct once.
  const first = wall - offsetAt(timeZone, new Date(wall));
  const instant = new Date(wall - offsetAt(timeZone, new Date(first)));
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The wall clock of `timeZone` at `instant`, as a `datetime-local` value; the empty string for an instant that cannot be read. */
export function instantToZoned(instant: string, timeZone: string): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime()) || !isKnownZone(timeZone)) return '';
  const p = fieldsAt(timeZone, at);
  return `${pad(p['year']!, 4)}-${pad(p['month']!)}-${pad(p['day']!)}T${pad(p['hour']! % 24)}:${pad(p['minute']!)}`;
}
