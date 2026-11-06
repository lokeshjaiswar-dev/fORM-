import type { IsoTime, TimeZone, Weekday } from '@form/schema';
import { defineField } from '../define.ts';
import { PALETTE_LABELS, regionOf } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const WORKDAYS: Weekday[] = [1, 2, 3, 4, 5];

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
    minNoticeMinutes: 60,
    rollingDays: 30,
    capacityPerSlot: 1,
    attachIcs: true,
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
  },
  paths: { '': 'text', start: 'text', end: 'text' },
  operators: { text: TEXT_OPS },
  toScalar: (value, path) => (isRootPath(path) || path === 'start' ? { t: 'text', v: value.start } : path === 'end' ? { t: 'text', v: value.end } : NULL),
  isEmpty: (value) => !value.start,
  cells: (value) => [`${value.start}–${value.end}`],
  hasDefault: () => false,
});
