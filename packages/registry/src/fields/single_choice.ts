import { graphemeLength } from '@form/i18n';
import { configTexts, defineField, headerOf } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { CHOICE_OPS, TEXT_OPS } from '../operators.ts';
import {
  NULL, defaultOptions, entry, hasOption, isRootPath, optionAltLint, optionLabel, optionScalar, optionTexts, otherTexts,
} from './shared.ts';

/**
 * FLD-10/12. One answer shape for every display (B25): `{ optionId }`, or `{ optionId: null, other }`
 * for "Other". The stored value is the option id, never its label (B15/B16).
 */
export const singleChoice = defineField({
  type: 'single_choice',
  palette: [
    entry('single_choice', 'radio', 'choice', PALETTE_LABELS['palette.single_choice.radio'], 'circle-dot', ['choice', 'radio', 'single', 'option', 'multiple choice'], { display: 'radio' }),
    entry('single_choice', 'dropdown', 'choice', PALETTE_LABELS['palette.single_choice.dropdown'], 'chevron-down', ['dropdown', 'select', 'list', 'single'], { display: 'dropdown' }),
  ],
  defaultConfig: (locale) => ({ display: 'radio', options: defaultOptions(locale) }),
  checkConfig: (config, report) => {
    if (config.defaultOptionId !== undefined && !hasOption(config.options, config.defaultOptionId)) report('defaultOptionId is not an option', ['defaultOptionId']);
    if (config.shuffle && config.shuffle.keepLast > config.options.length) report('shuffle.keepLast exceeds the number of options', ['shuffle', 'keepLast']);
  },
  checkAnswer: (value, block, _state, report) => {
    const { options, other } = block.config;
    if (value.optionId !== null && !hasOption(options, value.optionId)) report('not_in_options', ['optionId']);
    if (value.other === undefined) return;
    if (!other?.enabled || value.optionId !== null) report('not_in_options', ['other']);
    else if (other.maxLength !== undefined && graphemeLength(value.other) > other.maxLength) report('too_long', ['other']);
  },
  paths: { '': 'choice', other: 'text' },
  operators: { choice: CHOICE_OPS, text: TEXT_OPS },
  toScalar: (value, path) => {
    if (isRootPath(path)) return value.optionId === null ? NULL : optionScalar(value.optionId);
    return path === 'other' && value.other !== undefined ? { t: 'text', v: value.other } : NULL;
  },
  isEmpty: (value) => value.optionId === null && (value.other ?? '') === '',
  columns: (block) => {
    const header = headerOf(block);
    return block.config.other?.enabled ? [{ suffix: '', header }, { suffix: '.other', header: `${header} (${block.config.other.label?.trim() || 'Other'})` }] : [{ suffix: '', header }];
  },
  cells: (value, block) => {
    const choice = value.optionId === null ? '' : optionLabel(block.config.options, value.optionId);
    return block.config.other?.enabled ? [choice, value.other ?? ''] : [choice];
  },
  text: (value, block) => (value.optionId === null ? (value.other ?? '') : optionLabel(block.config.options, value.optionId)),
  texts: (block) => [...optionTexts(block.id, block.config.options), ...otherTexts(block.id, block.config.other), ...configTexts(block, ['placeholder'])],
  content: (block) => (block.config.other ? ['/config/options', '/config/other'] : ['/config/options']),
  hasDefault: (block) => block.config.defaultOptionId !== undefined,
  lint: (block) => optionAltLint(block.id, block.config.options),
});
