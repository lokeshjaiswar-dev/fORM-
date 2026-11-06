import type { AppointmentConfig, IsoDate, IsoInstant, IsoTime, Weekday } from '@form/schema';

const MONTH_OFFSET = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4] as const;

function weekdayOf(date: string): Weekday {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  const year = m < 3 ? y - 1 : y;
  return ((year + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400) + (MONTH_OFFSET[m - 1] ?? 0) + d) % 7) as Weekday;
}

function minutesOf(time: string): number {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return h * 60 + m;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function addDays(day: IsoDate, n: number): IsoDate {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}` as IsoDate;
}

function wallDay(now: Date, timeZone: string): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '01';
  return `${pick('year')}-${pick('month')}-${pick('day')}` as IsoDate;
}

function offsetMs(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset', hour: '2-digit' }).formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60_000;
}

function instantOf(day: IsoDate, time: IsoTime, timeZone: string): IsoInstant {
  const utc = Date.parse(`${day}T${time}:00.000Z`);
  return new Date(utc - offsetMs(new Date(utc), timeZone)).toISOString().replace(/\.\d{3}Z$/, 'Z') as IsoInstant;
}

export interface AppointmentSlot {
  start: IsoInstant;
  end: IsoInstant;
  day: IsoDate;
  time: IsoTime;
}

/** Open slots from `now` for the next `rollingDays` calendar days in the appointment zone. */
export function slotsOf(config: AppointmentConfig, now = new Date()): AppointmentSlot[] {
  const tz = config.timeZone;
  const step = config.slotStepMinutes ?? config.slotMinutes;
  const length = config.slotMinutes;
  const notice = now.getTime() + config.minNoticeMinutes * 60_000;
  const startDay = wallDay(now, tz);
  const out: AppointmentSlot[] = [];
  for (let i = 0; i < config.rollingDays; i += 1) {
    const day = addDays(startDay, i);
    if ((config.blockedDates ?? []).some((d) => (typeof d === 'string' ? d === day : d.from <= day && day <= d.to))) continue;
    for (const window of config.weekly.filter((w) => w.weekday === weekdayOf(day))) {
      for (let m = minutesOf(window.from); m + length <= minutesOf(window.to); m += step) {
        const time = `${pad(Math.floor(m / 60))}:${pad(m % 60)}` as IsoTime;
        const start = instantOf(day, time, tz);
        const endM = m + length;
        const end = instantOf(day, `${pad(Math.floor(endM / 60))}:${pad(endM % 60)}` as IsoTime, tz);
        if (Date.parse(start) < notice) continue;
        out.push({ start, end, day, time });
      }
    }
  }
  return out;
}
