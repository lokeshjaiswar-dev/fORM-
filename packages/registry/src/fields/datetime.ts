import type { DateBound, IsoLocalDateTime } from '@form/schema';
import { defineField } from '../define.ts';
import { PALETTE_LABELS, datePatternFor, hourCycleFor } from '../messages.ts';
import { TEMPORAL_OPS } from '../operators.ts';
import { weekdayOf } from '../util/calendar.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const absolute = (bound: DateBound | undefined): string | undefined => (bound?.kind === 'absolute' ? bound.date : undefined);
const dateOf = (local: IsoLocalDateTime): string => local.slice(0, 10);

/**
 * FLD-18. Local date-time plus a zone; absolute date bounds reuse the date field's rules on the calendar day.
 */
export const datetime = defineField({
  type: 'datetime',
  palette: [entry('datetime', null, 'basic', PALETTE_LABELS['palette.datetime'], 'calendar-clock', ['datetime', 'date time', 'timestamp', 'appointment', 'schedule'])],
  defaultConfig: (locale) => ({
    pattern: datePatternFor(locale),
    hourCycle: hourCycleFor(locale),
    minuteStep: 5,
    timeZone: 'respondent',
  }),
  checkConfig: (config, report) => {
    const min = absolute(config.limits?.min);
    const max = absolute(config.limits?.max);
    if (min !== undefined && max !== undefined && min > max) report('limits.min must not be after limits.max', ['limits', 'min']);
  },
  checkAnswer: (value, block, _state, report) => {
    const limits = block.config.limits;
    if (!limits) return;
    const day = dateOf(value.local);
    const min = absolute(limits.min);
    const max = absolute(limits.max);
    if ((min !== undefined && day < min) || (max !== undefined && day > max)) report('date_out_of_range');
    const blocked = limits.disallowWeekdays?.includes(weekdayOf(day))
      || limits.disallowDates?.some((d) => (typeof d === 'string' ? d === day : d.from <= day && day <= d.to));
    if (blocked) report('date_not_allowed');
  },
  paths: { '': 'datetime' },
  operators: { datetime: TEMPORAL_OPS },
  toScalar: (value, path) => (isRootPath(path) ? { t: 'datetime', v: value.local, tz: value.timeZone } : NULL),
  isEmpty: (value) => value.local === '',
  cells: (value) => [`${value.local} ${value.timeZone}`],
  hasDefault: (block) => block.config.defaultValue !== undefined,
});
