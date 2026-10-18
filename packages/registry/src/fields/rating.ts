import { configTexts, defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { NUMBER_OPS } from '../operators.ts';
import { NULL, countScalar, entry, isRootPath } from './shared.ts';

/** FLD-20. `max` is 1–10 in the config schema (B28); an answer is 1..max, and unanswered is absent. */
export const rating = defineField({
  type: 'rating',
  palette: [entry('rating', null, 'rating', PALETTE_LABELS['palette.rating'], 'star', ['rating', 'stars', 'score', 'review'])],
  defaultConfig: () => ({ max: 5, icon: 'star' }),
  checkConfig: (config, report) => {
    if (config.defaultValue !== undefined && config.defaultValue > config.max) report('defaultValue exceeds max', ['defaultValue']);
  },
  checkAnswer: (value, block, _state, report) => {
    if (value < 1) report('below_min');
    if (value > block.config.max) report('above_max');
  },
  paths: { '': 'number' },
  operators: { number: NUMBER_OPS },
  toScalar: (value, path) => (isRootPath(path) ? countScalar(value) : NULL),
  isEmpty: () => false,
  cells: (value) => [String(value)],
  texts: (block) => configTexts(block, ['lowLabel', 'highLabel']),
  hasDefault: (block) => block.config.defaultValue !== undefined,
});
