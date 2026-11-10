import type { DecimalString } from '@form/schema';
import { defineField, headerOf } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { NUMBER_OPS } from '../operators.ts';
import { compareDecimal, isInteger } from '../util/decimal.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const checkBound = (value: DecimalString, block: { config: { min?: DecimalString; max?: DecimalString; integerOnly?: boolean; allowNegative?: boolean } }, path: string, report: (code: 'not_integer' | 'below_min' | 'above_max', path?: string[]) => void): void => {
  const { min, max, integerOnly, allowNegative } = block.config;
  if (integerOnly && !isInteger(value)) report('not_integer', [path]);
  if (allowNegative === false && compareDecimal(value, '0') < 0) report('below_min', [path]);
  if (min !== undefined && compareDecimal(value, min) < 0) report('below_min', [path]);
  if (max !== undefined && compareDecimal(value, max) > 0) report('above_max', [path]);
};

/** Two decimal endpoints; `to` must not be below `from`. */
export const numberRange = defineField({
  type: 'number_range',
  palette: [entry('number_range', null, 'basic', PALETTE_LABELS['palette.number_range'], 'chevrons-left-right', ['number range', 'from', 'to', 'between', 'span', 'interval'])],
  defaultConfig: () => ({ integerOnly: false, allowNegative: true }),
  checkConfig: (config, report) => {
    if (config.min !== undefined && config.max !== undefined && compareDecimal(config.min, config.max) > 0) report('min must not exceed max', ['min']);
  },
  checkAnswer: (value, block, _state, report) => {
    if (compareDecimal(value.to, value.from) < 0) report('invalid_format', ['to']);
    checkBound(value.from, block, 'from', report);
    checkBound(value.to, block, 'to', report);
  },
  paths: { '': 'number', from: 'number', to: 'number' },
  operators: { number: NUMBER_OPS },
  toScalar: (value, path) => (isRootPath(path) || path === 'from' ? { t: 'number', v: value.from } : path === 'to' ? { t: 'number', v: value.to } : NULL),
  isEmpty: (value) => !value.from || !value.to,
  columns: (block) => {
    const header = headerOf(block);
    return [{ suffix: '.from', header: `${header} from` }, { suffix: '.to', header: `${header} to` }];
  },
  cells: (value) => [value.from, value.to],
  text: (value) => `${value.from}–${value.to}`,
});
