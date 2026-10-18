import type { RankingConfig } from '@form/schema';
import { defineField, headerOf } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { PRESENCE_OPS } from '../operators.ts';
import {
  NULL, checkOptionIds, defaultOptions, entry, isRootPath, optionAltLint, optionLabel, optionList, optionTexts,
} from './shared.ts';

/** How many positions a respondent ranks: `rankTop` of the options, or all of them. */
export const rankCount = (config: RankingConfig): number => Math.min(config.rankTop ?? config.options.length, config.options.length);

/**
 * FLD-23. The answer exists only once the respondent has ranked (B8): no default order is stored, and a
 * required ranking must place every position.
 */
export const ranking = defineField({
  type: 'ranking',
  palette: [entry('ranking', null, 'rating', PALETTE_LABELS['palette.ranking'], 'list-ordered', ['ranking', 'order', 'rank', 'priority', 'sort'])],
  defaultConfig: (locale) => ({ options: defaultOptions(locale) }),
  checkConfig: (config, report) => {
    if (config.rankTop !== undefined && config.rankTop > config.options.length) report('rankTop exceeds the number of options', ['rankTop']);
  },
  checkAnswer: (value, block, state, report) => {
    checkOptionIds(value, block.config.options, [], report);
    const expected = rankCount(block.config);
    if (value.length > expected) report('too_many_selected');
    if (state.required && value.length < expected) report('too_few_selected');
  },
  paths: { '': 'choices' },
  operators: { choices: PRESENCE_OPS },
  toScalar: (value, path) => (isRootPath(path) ? optionList(value) : NULL),
  isEmpty: (value) => value.length === 0,
  columns: (block) => {
    const header = headerOf(block);
    return Array.from({ length: rankCount(block.config) }, (_, i) => ({ suffix: `.${i + 1}`, header: `${header} #${i + 1}` }));
  },
  cells: (value, block) => Array.from({ length: rankCount(block.config) }, (_, i) => {
    const id = value[i];
    return id === undefined ? '' : optionLabel(block.config.options, id);
  }),
  text: (value, block) => value.map((id) => optionLabel(block.config.options, id)).join(' > '),
  texts: (block) => optionTexts(block.id, block.config.options),
  content: () => ['/config/options'],
  lint: (block) => optionAltLint(block.id, block.config.options),
});
