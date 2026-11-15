import type { IsoInstant, RichDoc, RuntimeStatus, StatusScreenRole } from '@form/schema';

/*
 * What a respondent may do with a form right now (WP-1.07: ACC-01..06). Pure: the caller hands over the stored rules,
 * the submission counter and the clock, so a test freezes time and the runtime host (WP-1.09) and the submit
 * transaction (WP-1.12) read the same answer. Nothing here reads the clock, the database or the environment, except
 * Intl for the zone arithmetic.
 */

/** The stored rules that decide the status (a subset of `AccessSettings`, so a test builds one by hand). */
export interface AccessRules {
  enabled: boolean;
  /** Instants: compared in UTC, whatever zone the author thought in. */
  openAt: Date | null;
  closeAt: Date | null;
  /** Weekly windows in the form's own zone (ACC-06); null means always. */
  availability: { timeZone: string; windows: ReadonlyArray<{ weekdays: readonly number[]; from: string; to: string }> } | null;
  submissionLimit: number | null;
  hasPassword: boolean;
  /** The author's text for a status screen, by role; a role without one gets an empty screen (the renderer's own words). */
  screens: Partial<Record<StatusScreenRole, { content: RichDoc }>>;
}

export interface AccessCounters {
  /** `form_counters.submitted_total`. */
  submittedTotal: number;
}

export interface StatusOptions {
  /** The caller holds a valid access token for this form (`verifyAccessToken`), so the password screen is behind it. */
  unlocked?: boolean;
}

const EMPTY_SCREEN: RichDoc = { type: 'doc', content: [] };

const instant = (d: Date): IsoInstant => d.toISOString() as IsoInstant;

/**
 * The status, in this order (the first that applies wins):
 *
 * 1. `closed`: the form is switched off (ACC-01), or its close date has passed (ACC-02).
 * 2. `not_yet_open`: before the open date (ACC-03), with the instant it opens.
 * 3. `limit_reached`: the counter has reached the limit (ACC-04).
 * 4. `outside_hours`: outside every weekly window, in the window's own zone (ACC-06).
 * 5. `password`: the form has a password and the caller has not unlocked it.
 * 6. `open`.
 *
 * ACC-04 closes the form at whichever of the date or the limit comes first. The counter says that the limit was reached,
 * not when, so once the close date has passed too the answer is `closed`: the date is the part that is knowable.
 * A closed form never asks for its password.
 */
export function runtimeStatus(access: AccessRules, counters: AccessCounters, now: Date, options: StatusOptions = {}): RuntimeStatus {
  const screen = (role: StatusScreenRole): RichDoc => access.screens[role]?.content ?? EMPTY_SCREEN;
  const t = now.getTime();

  if (!access.enabled || (access.closeAt !== null && t >= access.closeAt.getTime())) return { state: 'closed', screen: screen('closed') };
  if (access.openAt !== null && t < access.openAt.getTime()) return { state: 'not_yet_open', opensAt: instant(access.openAt), screen: screen('not_yet_open') };
  if (access.submissionLimit !== null && counters.submittedTotal >= access.submissionLimit) return { state: 'limit_reached', screen: screen('limit_reached') };

  if (access.availability !== null) {
    let inside: boolean;
    let next: Date | null = null;
    try {
      inside = isInsideWindows(access.availability, now);
      if (!inside) next = nextWindowStart(access.availability, now);
    } catch {
      // A zone Intl does not know cannot be checked, and a form must not open on a rule it cannot read: closed until
      // the author fixes the zone. The access route refuses such a zone, so only a row written another way gets here.
      return { state: 'closed', screen: screen('closed') };
    }
    if (!inside) {
      // The next window may start after the form closes: then there is no next opening to promise.
      const nextOpenAt = next !== null && (access.closeAt === null || next.getTime() < access.closeAt.getTime()) ? instant(next) : undefined;
      return { state: 'outside_hours', ...(nextOpenAt ? { nextOpenAt } : {}), screen: screen('outside_hours') };
    }
  }

  if (access.hasPassword && !options.unlocked) return { state: 'password', screen: screen('password') };
  return { state: 'open' };
}

/* ── weekly windows ─────────────────────────────────────────────────────────────────────────────────────────────── */

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One formatter per zone: they are slow to build, and a process meets few zones. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, f);
  }
  return f;
}

interface Local {
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday, as the form's `weekdays` count. */
  weekday: number;
  /** Seconds since local midnight. */
  seconds: number;
}

/** The wall clock of `timeZone` at the instant `d`. */
function localAt(timeZone: string, d: Date): Local {
  const p: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(d)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const year = p['year']!;
  const month = p['month']!;
  const day = p['day']!;
  // The weekday of a calendar date does not depend on the zone: take it from the date as if it were UTC.
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(), seconds: (p['hour']! % 24) * 3600 + p['minute']! * 60 + p['second']! };
}

/** Seconds since midnight of `HH:MM`; a window that ends at 23:59 runs to the end of the day. */
const startSeconds = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 3600 + Number(hhmm.slice(3, 5)) * 60;
const endSeconds = (hhmm: string): number => (hhmm === '23:59' ? 86_400 : startSeconds(hhmm));

type Availability = NonNullable<AccessRules['availability']>;

/**
 * Whether the wall clock of the window's zone is inside one window: from inclusive to exclusive. A window whose `to` is
 * before its `from` runs over midnight: the weekdays name the day it starts, so Friday 22:00 to 02:00 is open on Saturday
 * until 02:00.
 */
function isInsideWindows(availability: Availability, at: Date): boolean {
  const local = localAt(availability.timeZone, at);
  const yesterday = (local.weekday + 6) % 7;
  return availability.windows.some((w) => {
    const from = startSeconds(w.from);
    const to = endSeconds(w.to);
    if (from < to) return w.weekdays.includes(local.weekday) && local.seconds >= from && local.seconds < to;
    if (from === to) return false;
    return (w.weekdays.includes(local.weekday) && local.seconds >= from) || (w.weekdays.includes(yesterday) && local.seconds < to);
  });
}

/** The UTC offset of `timeZone` at the instant `d`, in milliseconds. */
function offsetAt(timeZone: string, d: Date): number {
  const l = localAt(timeZone, d);
  return Date.UTC(l.year, l.month - 1, l.day) + l.seconds * 1000 - Math.floor(d.getTime() / 1000) * 1000;
}

/** The instant the wall clock of `timeZone` reads `seconds` after midnight on the given calendar date. */
function zonedInstant(timeZone: string, y: number, m: number, d: number, seconds: number): Date {
  const wall = Date.UTC(y, m - 1, d) + seconds * 1000;
  // The offset at the guess may differ from the offset at the answer across a clock change: correct once.
  const first = wall - offsetAt(timeZone, new Date(wall));
  return new Date(wall - offsetAt(timeZone, new Date(first)));
}

/** The first moment after `after` that a window opens, within the next eight days; null when no window ever opens. */
function nextWindowStart(availability: Availability, after: Date): Date | null {
  const today = localAt(availability.timeZone, after);
  let best: Date | null = null;
  for (let ahead = 0; ahead <= 8; ahead++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead));
    const [y, m, d, weekday] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), day.getUTCDay()] as const;
    for (const w of availability.windows) {
      if (!w.weekdays.includes(weekday) || startSeconds(w.from) === endSeconds(w.to)) continue;
      const start = zonedInstant(availability.timeZone, y, m, d, startSeconds(w.from));
      if (start.getTime() > after.getTime() && (best === null || start.getTime() < best.getTime())) best = start;
    }
    if (best !== null) return best;
  }
  return null;
}
