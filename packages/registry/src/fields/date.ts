import type { DateBound } from '@form/schema';
import { defineField } from '../define.ts';
import { PALETTE_LABELS, datePatternFor } from '../messages.ts';
import { TEMPORAL_OPS } from '../operators.ts';
import { weekdayOf } from '../util/calendar.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const absolute = (bound: DateBound | undefined): string | undefined => (bound?.kind === 'absolute' ? bound.date : undefined);

/**
 * FLD-16/17. Absolute bounds, weekdays and blocked dates are checked here; relative and field bounds,
 * age and holiday calendars need `meta.today` or other answers and run in @form/validation.
 */
export const date = defineField({
  type: 'date',
  palette: [entry('date', null, 'date_time', PALETTE_LABELS['palette.date'], 'calendar', ['date', 'day', 'calendar', 'birthday', 'dob'])],
  defaultConfig: (locale) => ({ pattern: datePatternFor(locale), picker: 'calendar' }),
  checkConfig: (config, report) => {
    const min = absolute(config.limits?.min);
    const max = absolute(config.limits?.max);
    if (min !== undefined && max !== undefined && min > max) report('limits.min must not be after limits.max', ['limits', 'min']);
    config.limits?.disallowDates?.forEach((d, i) => typeof d !== 'string' && d.from > d.to && report('a blocked range must not end before it starts', ['limits', 'disallowDates', i]));
    const fixed = config.defaultValue?.kind === 'fixed' ? config.defaultValue.date : undefined;
    if (fixed !== undefined && ((min !== undefined && fixed < min) || (max !== undefined && fixed > max))) {
      report('defaultValue is outside the limits', ['defaultValue', 'date']);
    }
  },
  checkAnswer: (value, block, _state, report) => {
    const limits = block.config.limits;
    if (!limits) return;
    const min = absolute(limits.min);
    const max = absolute(limits.max);
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) report('date_out_of_range');
    const blocked = limits.disallowWeekdays?.includes(weekdayOf(value))
      || limits.disallowDates?.some((d) => (typeof d === 'string' ? d === value : d.from <= value && value <= d.to));
    if (blocked) report('date_not_allowed');
  },
  paths: { '': 'date' },
  operators: { date: TEMPORAL_OPS },
  toScalar: (value, path) => (isRootPath(path) ? { t: 'date', v: value } : NULL),
  isEmpty: (value) => value === '',
  cells: (value) => [value],
  hasDefault: (block) => block.config.defaultValue !== undefined,
});
