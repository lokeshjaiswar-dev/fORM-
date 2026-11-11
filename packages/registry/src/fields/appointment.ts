import type { AppointmentConfig, IsoInstant, IsoTime, TimeZone, Weekday } from '@form/schema';
import { defineField } from '../define.ts';
import { PALETTE_LABELS, regionOf } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const WORKDAYS: Weekday[] = [1, 2, 3, 4, 5];

function formatClock(instant: string, timeZone: string): { date: string; time: string } | null {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return null;
  const date = new Intl.DateTimeFormat('en-IN', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(at);
  const time = new Intl.DateTimeFormat('en-IN', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(at);
  return { date, time };
}

function formatSlot(start: string, end: string, timeZone: string): string {
  const from = formatClock(start, timeZone);
  const to = formatClock(end, timeZone);
  if (!from || !to) return `${start} – ${end}`;
  return `${from.date}, ${from.time} – ${to.time}`;
}

function chosenSlots(value: { start: IsoInstant; end: IsoInstant; slots?: Array<{ start: IsoInstant; end: IsoInstant }> }): Array<{ start: string; end: string }> {
  return value.slots && value.slots.length > 0 ? value.slots : [{ start: value.start, end: value.end }];
}

export function formatAppointmentAnswer(
  value: { start: IsoInstant; end: IsoInstant; respondentTimeZone?: string; slots?: Array<{ start: IsoInstant; end: IsoInstant }> },
  config?: Pick<AppointmentConfig, 'timeZone'>,
): string {
  const zone = value.respondentTimeZone || config?.timeZone || 'UTC';
  if (!value.start) return '';
  return chosenSlots(value).map((slot) => formatSlot(slot.start, slot.end, zone)).join('; ');
}

/** FLD-35. Client lists slots from weekly hours; the server still owns the hold. */
export const appointment = defineField({
  type: 'appointment',
  palette: [entry('appointment', null, 'advanced', PALETTE_LABELS['palette.appointment'], 'calendar', ['appointment', 'booking', 'slot', 'schedule', 'meeting', 'calendar'])],
  defaultConfig: (locale) => ({
    timeZone: (regionOf(locale) === 'IN' ? 'Asia/Kolkata' : 'UTC') as TimeZone,
    allowRespondentTimeZone: false,
    slotMinutes: 30,
    bufferMinutes: 0,
    weekly: WORKDAYS.map((weekday) => ({ weekday, from: '09:00' as IsoTime, to: '17:00' as IsoTime })),
    minNoticeMinutes: 0,
    rollingDays: 30,
    capacityPerSlot: 1,
    attachIcs: true,
    allowMultipleTimes: false,
  }),
  checkConfig: (config, report) => {
    if (config.slotMinutes < 1) report('slotMinutes must be at least 1', ['slotMinutes']);
    if (config.rollingDays < 1) report('rollingDays must be at least 1', ['rollingDays']);
    config.weekly.forEach((w, i) => {
      if (w.from >= w.to) report('weekly hours must end after they start', ['weekly', i]);
    });
  },
  checkAnswer: (value, _block, _state, report) => {
    if (value.end <= value.start) report('invalid_format', ['end']);
    value.slots?.forEach((slot, i) => {
      if (slot.end <= slot.start) report('invalid_format', ['slots', i, 'end']);
    });
  },
  paths: { '': 'text', start: 'text', end: 'text' },
  operators: { text: TEXT_OPS },
  toScalar: (value, path) => (isRootPath(path) || path === 'start' ? { t: 'text', v: value.start } : path === 'end' ? { t: 'text', v: value.end } : NULL),
  isEmpty: (value) => !value.start,
  cells: (value, block) => [formatAppointmentAnswer(value, block.config)],
  text: (value, block) => formatAppointmentAnswer(value, block.config),
  hasDefault: () => false,
});
