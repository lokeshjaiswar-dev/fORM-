import { configTexts, defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { NUMBER_OPS } from '../operators.ts';
import { NULL, countScalar, entry, isRootPath } from './shared.ts';

/** FLD-21. No default selection: unanswered is absent, so 0 never shows as chosen (B7). */
export const linearScale = defineField({
  type: 'linear_scale',
  palette: [entry('linear_scale', null, 'rating', PALETTE_LABELS['palette.linear_scale'], 'gauge', ['scale', 'linear', 'likert', 'range', 'opinion'])],
  defaultConfig: () => ({ min: 1, max: 5 }),
  checkAnswer: (value, block, _state, report) => {
    if (value < block.config.min) report('below_min');
    if (value > block.config.max) report('above_max');
  },
  paths: { '': 'number' },
  operators: { number: NUMBER_OPS },
  toScalar: (value, path) => (isRootPath(path) ? countScalar(value) : NULL),
  isEmpty: () => false,
  cells: (value) => [String(value)],
  texts: (block) => configTexts(block, ['lowLabel', 'midLabel', 'highLabel']),
});
