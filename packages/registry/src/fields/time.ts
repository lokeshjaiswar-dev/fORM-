import { defineField, headerOf } from '../define.ts';
import { PALETTE_LABELS, hourCycleFor } from '../messages.ts';
import { TEMPORAL_OPS } from '../operators.ts';
import { minutesOf } from '../util/calendar.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const NOON = 12 * 60;

/** FLD-19. `end` is present exactly when the block asks for a range. */
export const time = defineField({
  type: 'time',
  palette: [entry('time', null, 'date_time', PALETTE_LABELS['palette.time'], 'clock', ['time', 'hour', 'clock', 'slot'])],
  defaultConfig: (locale) => ({ hourCycle: hourCycleFor(locale), minuteStep: 5 }),
  checkConfig: (config, report) => {
    const range = config.range;
    if (range?.minMinutes !== undefined && range.maxMinutes !== undefined && range.minMinutes > range.maxMinutes) {
      report('range.minMinutes must not exceed range.maxMinutes', ['range', 'minMinutes']);
    }
    const from = config.window?.from;
    const to = config.window?.to;
    if (from !== undefined && to !== undefined && from > to) report('window.from must not be after window.to', ['window', 'from']);
    const fixed = config.defaultValue?.kind === 'fixed' ? config.defaultValue.time : undefined;
    if (fixed !== undefined && ((from !== undefined && fixed < from) || (to !== undefined && fixed > to))) {
      report('defaultValue is outside the window', ['defaultValue', 'time']);
    }
  },
  checkAnswer: (value, block, _state, report) => {
    const { range, window, period } = block.config;
    const times = value.end === undefined ? [value.start] : [value.start, value.end];
    if (range?.enabled) {
      if (value.end === undefined) report('invalid_time', ['end']);
      else {
        const minutes = minutesOf(value.end) - minutesOf(value.start);
        if (minutes <= 0) report('time_out_of_range', ['end']);
        else if ((range.minMinutes !== undefined && minutes < range.minMinutes) || (range.maxMinutes !== undefined && minutes > range.maxMinutes)) {
          report('time_out_of_range', ['end']);
        }
      }
    } else if (value.end !== undefined) {
      report('invalid_time', ['end']);
    }
    const from = window?.from;
    const to = window?.to;
    if (times.some((t) => (from !== undefined && t < from) || (to !== undefined && t > to))) report('time_out_of_range');
    if (period === 'am_only' && times.some((t) => minutesOf(t) >= NOON)) report('time_out_of_range');
    if (period === 'pm_only' && times.some((t) => minutesOf(t) < NOON)) report('time_out_of_range');
  },
  paths: { '': 'time', start: 'time', end: 'time' },
  operators: { time: TEMPORAL_OPS },
  toScalar: (value, path) => {
    if (isRootPath(path) || path === 'start') return { t: 'time', v: value.start };
    return path === 'end' && value.end !== undefined ? { t: 'time', v: value.end } : NULL;
  },
  isEmpty: (value) => value.start === '',
  columns: (block) => {
    const header = headerOf(block);
    return block.config.range?.enabled ? [{ suffix: '', header }, { suffix: '.end', header: `${header} (end)` }] : [{ suffix: '', header }];
  },
  cells: (value, block) => (block.config.range?.enabled ? [value.start, value.end ?? ''] : [value.start]),
  text: (value) => (value.end === undefined ? value.start : `${value.start}–${value.end}`),
  hasDefault: (block) => block.config.defaultValue !== undefined,
});
