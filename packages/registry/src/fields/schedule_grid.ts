import type { IsoTime, Weekday } from '@form/schema';
import { defineField, headerOf } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { PRESENCE_OPS } from '../operators.ts';
import { NULL, countScalar, entry, isRootPath } from './shared.ts';

const WORKDAYS: Weekday[] = [1, 2, 3, 4, 5];
const DEFAULT_SLOTS = ['09:00', '12:00', '15:00'] as IsoTime[];

const keyOf = (weekday: Weekday, time: IsoTime): string => `${weekday}:${time}`;

/** Tick cells on a weekday × time-slot grid (availability, not a booking hold). */
export const scheduleGrid = defineField({
  type: 'schedule_grid',
  palette: [entry('schedule_grid', null, 'date_time', PALETTE_LABELS['palette.schedule_grid'], 'calendar-days', ['schedule', 'availability', 'week', 'slots', 'timetable'])],
  defaultConfig: () => ({ weekdays: WORKDAYS, slots: DEFAULT_SLOTS }),
  checkConfig: (config, report) => {
    const days = new Set<Weekday>();
    config.weekdays.forEach((d, i) => {
      if (days.has(d)) report('weekdays must be unique', ['weekdays', i]);
      days.add(d);
    });
    const slots = new Set<string>();
    config.slots.forEach((s, i) => {
      if (slots.has(s)) report('slots must be unique', ['slots', i]);
      slots.add(s);
    });
  },
  checkAnswer: (value, block, _state, report) => {
    const days = new Set(block.config.weekdays);
    const slots = new Set(block.config.slots);
    const seen = new Set<string>();
    value.forEach((cell, i) => {
      if (!days.has(cell.weekday) || !slots.has(cell.time)) report('not_in_options', [i]);
      const key = keyOf(cell.weekday, cell.time);
      if (seen.has(key)) report('invalid_format', [i]);
      seen.add(key);
    });
  },
  paths: { '': 'choices' },
  operators: { choices: PRESENCE_OPS },
  toScalar: (value, path) => (isRootPath(path) ? countScalar(value.length) : NULL),
  isEmpty: (value) => value.length === 0,
  columns: (block) => {
    const header = headerOf(block);
    return block.config.weekdays.flatMap((day) =>
      block.config.slots.map((slot) => ({ suffix: `.${day}_${slot.replace(':', '')}`, header: `${header} ${day} ${slot}` })),
    );
  },
  cells: (value, block) => {
    const picked = new Set(value.map((c) => keyOf(c.weekday, c.time)));
    return block.config.weekdays.flatMap((day) => block.config.slots.map((slot) => (picked.has(keyOf(day, slot)) ? 'yes' : '')));
  },
});
