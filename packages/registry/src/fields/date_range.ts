import type { DateBound, IsoDate } from '@form/schema';
import { defineField, headerOf } from '../define.ts';
import { PALETTE_LABELS, datePatternFor } from '../messages.ts';
import { TEMPORAL_OPS } from '../operators.ts';
import { weekdayOf } from '../util/calendar.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const absolute = (bound: DateBound | undefined): string | undefined => (bound?.kind === 'absolute' ? bound.date : undefined);

const daysBetween = (start: IsoDate, end: IsoDate): number =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);

const checkDate = (value: IsoDate, limits: { min?: DateBound; max?: DateBound; disallowWeekdays?: readonly number[]; disallowDates?: ReadonlyArray<IsoDate | { from: IsoDate; to: IsoDate }> } | undefined, path: string, report: (code: 'date_out_of_range' | 'date_not_allowed', path?: string[]) => void): void => {
  if (!limits) return;
  const min = absolute(limits.min);
  const max = absolute(limits.max);
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) report('date_out_of_range', [path]);
  const blocked = limits.disallowWeekdays?.includes(weekdayOf(value))
    || limits.disallowDates?.some((d) => (typeof d === 'string' ? d === value : d.from <= value && value <= d.to));
  if (blocked) report('date_not_allowed', [path]);
};

/** Start and end calendar dates with optional span and shared date limits. */
export const dateRange = defineField({
  type: 'date_range',
  palette: [entry('date_range', null, 'date_time', PALETTE_LABELS['palette.date_range'], 'calendar-range', ['date range', 'from', 'to', 'span', 'period', 'stay'])],
  defaultConfig: (locale) => ({ pattern: datePatternFor(locale), picker: 'calendar', allowSameDay: true }),
  checkConfig: (config, report) => {
    const min = absolute(config.limits?.min);
    const max = absolute(config.limits?.max);
    if (min !== undefined && max !== undefined && min > max) report('limits.min must not be after limits.max', ['limits', 'min']);
    if (config.minSpanDays !== undefined && config.maxSpanDays !== undefined && config.minSpanDays > config.maxSpanDays) {
      report('minSpanDays must not exceed maxSpanDays', ['minSpanDays']);
    }
    if (!config.allowSameDay && config.minSpanDays === 0) report('minSpanDays 0 requires allowSameDay', ['minSpanDays']);
  },
  checkAnswer: (value, block, _state, report) => {
    const span = daysBetween(value.start, value.end);
    if (value.end < value.start || (!block.config.allowSameDay && span === 0)) report('invalid_format', ['end']);
    else {
      if (block.config.minSpanDays !== undefined && span < block.config.minSpanDays) report('below_min', ['end']);
      if (block.config.maxSpanDays !== undefined && span > block.config.maxSpanDays) report('above_max', ['end']);
    }
    checkDate(value.start, block.config.limits, 'start', report);
    checkDate(value.end, block.config.limits, 'end', report);
  },
  paths: { '': 'date', start: 'date', end: 'date' },
  operators: { date: TEMPORAL_OPS },
  toScalar: (value, path) => (isRootPath(path) || path === 'start' ? { t: 'date', v: value.start } : path === 'end' ? { t: 'date', v: value.end } : NULL),
  isEmpty: (value) => !value.start || !value.end,
  columns: (block) => {
    const header = headerOf(block);
    return [{ suffix: '.start', header: `${header} start` }, { suffix: '.end', header: `${header} end` }];
  },
  cells: (value) => [value.start, value.end],
  text: (value) => `${value.start}–${value.end}`,
});
