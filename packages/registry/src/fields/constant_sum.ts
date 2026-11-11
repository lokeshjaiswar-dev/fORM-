import type { OptionId } from '@form/schema';
import { defineField, headerOf } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { NUMBER_OPS } from '../operators.ts';
import { NULL, countScalar, defaultOptions, entry, hasOption, isRootPath, optionAltLint, optionLabel, optionTexts, pairLines } from './shared.ts';

const allocated = (value: Partial<Record<OptionId, number>>): number[] =>
  Object.values(value).filter((n): n is number => typeof n === 'number');

/** Allocate a fixed budget across options; a complete answer sums to `target`. */
export const constantSum = defineField({
  type: 'constant_sum',
  palette: [entry('constant_sum', null, 'rating', PALETTE_LABELS['palette.constant_sum'], 'percent', ['constant sum', 'allocate', 'budget', 'points', 'distribute', 'share'])],
  defaultConfig: (locale) => ({ options: defaultOptions(locale), target: 100, allowZero: true }),
  checkConfig: (config, report) => {
    if (config.target < 1) report('target must be at least 1', ['target']);
    if (!config.allowZero && config.options.length > config.target) report('target is smaller than the number of options', ['target']);
  },
  checkAnswer: (value, block, state, report) => {
    for (const [id, n] of Object.entries(value) as Array<[OptionId, number | undefined]>) {
      if (n === undefined) continue;
      if (!hasOption(block.config.options, id)) report('not_in_options', [id]);
      if (n < 0) report('below_min', [id]);
      if (!block.config.allowZero && n === 0) report('below_min', [id]);
      if (n > block.config.target) report('above_max', [id]);
    }
    const missing = block.config.options.some((o) => value[o.id] === undefined);
    if (state.required && missing) report('too_few_selected');
    if (!missing) {
      const total = allocated(value).reduce((a, b) => a + b, 0);
      if (total < block.config.target) report('below_min');
      if (total > block.config.target) report('above_max');
    }
  },
  paths: { '': 'number' },
  operators: { number: NUMBER_OPS },
  toScalar: (value, path) => (isRootPath(path) ? countScalar(allocated(value).reduce((a, b) => a + b, 0)) : NULL),
  isEmpty: (value) => allocated(value).length === 0,
  columns: (block) => block.config.options.map((o) => ({ suffix: `.${o.id}`, header: `${headerOf(block)} ${optionLabel(block.config.options, o.id)}` })),
  cells: (value, block) => block.config.options.map((o) => (value[o.id] === undefined ? '' : String(value[o.id]))),
  text: (value, block) => pairLines(block.config.options.map((o) => [optionLabel(block.config.options, o.id), value[o.id] === undefined ? '' : String(value[o.id])] as const)),
  texts: (block) => optionTexts(block.id, block.config.options),
  content: () => ['/config/options'],
  lint: (block) => optionAltLint(block.id, block.config.options),
});
