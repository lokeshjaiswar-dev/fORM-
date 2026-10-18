import { configTexts, defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { NUMBER_OPS } from '../operators.ts';
import { compareDecimal, isInteger, isStepOf, scaled } from '../util/decimal.ts';
import { NULL, entry, isRootPath } from './shared.ts';

/** FLD-07. Exact decimal strings throughout; never a JS float (fixes B14 at the type level). */
export const number = defineField({
  type: 'number',
  palette: [entry('number', null, 'basic', PALETTE_LABELS['palette.number'], 'hash', ['number', 'numeric', 'amount', 'quantity', 'count'])],
  defaultConfig: () => ({ display: 'input' }),
  checkConfig: (config, report) => {
    const { min, max, step, defaultValue, allowNegative } = config;
    if (min !== undefined && max !== undefined && compareDecimal(min, max) > 0) report('min must not exceed max', ['min']);
    if (allowNegative === false) {
      if (min !== undefined && compareDecimal(min, '0') < 0) report('min must not be negative when allowNegative is false', ['min']);
      if (defaultValue !== undefined && compareDecimal(defaultValue, '0') < 0) report('defaultValue must not be negative when allowNegative is false', ['defaultValue']);
    }
    if (step !== undefined && (scaled(step) ?? 0n) <= 0n) report('step must be positive', ['step']);
    if (defaultValue !== undefined) {
      if (min !== undefined && compareDecimal(defaultValue, min) < 0) report('defaultValue is below min', ['defaultValue']);
      if (max !== undefined && compareDecimal(defaultValue, max) > 0) report('defaultValue is above max', ['defaultValue']);
    }
  },
  checkAnswer: (value, block, _state, report) => {
    const { min, max, step, integerOnly, allowNegative } = block.config;
    if (integerOnly && !isInteger(value)) report('not_integer');
    if (allowNegative === false && compareDecimal(value, '0') < 0) report('below_min');
    if (min !== undefined && compareDecimal(value, min) < 0) report('below_min');
    if (max !== undefined && compareDecimal(value, max) > 0) report('above_max');
    if (step !== undefined && !isStepOf(value, step, min ?? '0')) report('step');
  },
  paths: { '': 'number' },
  operators: { number: NUMBER_OPS },
  toScalar: (value, path) => (isRootPath(path) ? { t: 'number', v: value } : NULL),
  isEmpty: (value) => value === '',
  cells: (value) => [value],
  texts: (block) => configTexts(block, ['placeholder', 'prefix', 'suffix']),
  hasDefault: (block) => block.config.defaultValue !== undefined,
});
