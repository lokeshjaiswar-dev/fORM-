import { graphemeLength } from '@form/i18n';
import { configTexts, defineField, headerOf } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { CHOICES_OPS, NUMBER_OPS, TEXT_OPS } from '../operators.ts';
import {
  NULL, checkOptionIds, countScalar, defaultOptions, entry, hasOption, isRootPath, optionAltLint, optionLabel, optionList, optionTexts, otherTexts,
} from './shared.ts';

const SEPARATOR = '; ';

/** FLD-11/13. One answer shape for checkboxes and the dropdown alike (B25): `{ optionIds, other? }`. */
export const multiChoice = defineField({
  type: 'multi_choice',
  palette: [
    entry('multi_choice', 'checkbox', 'choice', PALETTE_LABELS['palette.multi_choice.checkbox'], 'check-square', ['checkbox', 'checkboxes', 'multiple', 'select many'], { display: 'checkbox' }),
    entry('multi_choice', 'dropdown', 'choice', PALETTE_LABELS['palette.multi_choice.dropdown'], 'list-filter', ['dropdown', 'multi-select', 'select many', 'tags'], { display: 'dropdown' }),
  ],
  defaultConfig: (locale) => ({ display: 'checkbox', options: defaultOptions(locale) }),
  checkConfig: (config, report) => {
    const { options, minSelected, maxSelected, other } = config;
    const choosable = options.length + (other?.enabled ? 1 : 0);
    if (minSelected !== undefined && maxSelected !== undefined && minSelected > maxSelected) report('minSelected must not exceed maxSelected', ['minSelected']);
    if (minSelected !== undefined && minSelected > choosable) report('minSelected exceeds the number of options', ['minSelected']);
    if (maxSelected !== undefined && (config.defaultOptionIds?.length ?? 0) > maxSelected) report('defaultOptionIds exceed maxSelected', ['defaultOptionIds']);
    (config.defaultOptionIds ?? []).forEach((id, i) => hasOption(options, id) || report('defaultOptionIds must be options', ['defaultOptionIds', i]));
    (config.exclusiveOptionIds ?? []).forEach((id, i) => hasOption(options, id) || report('exclusiveOptionIds must be options', ['exclusiveOptionIds', i]));
    if (config.shuffle && config.shuffle.keepLast > options.length) report('shuffle.keepLast exceeds the number of options', ['shuffle', 'keepLast']);
  },
  checkAnswer: (value, block, _state, report) => {
    const { options, other, minSelected, maxSelected, exclusiveOptionIds } = block.config;
    checkOptionIds(value.optionIds, options, ['optionIds'], report);
    if (value.other !== undefined) {
      if (!other?.enabled) report('not_in_options', ['other']);
      else if (other.maxLength !== undefined && graphemeLength(value.other) > other.maxLength) report('too_long', ['other']);
    }
    const count = value.optionIds.length + (value.other !== undefined ? 1 : 0);
    if (minSelected !== undefined && count < minSelected) report('too_few_selected');
    if (maxSelected !== undefined && count > maxSelected) report('too_many_selected');
    if (count > 1 && value.optionIds.some((id) => exclusiveOptionIds?.includes(id))) report('too_many_selected');
  },
  paths: { '': 'choices', other: 'text', count: 'number' },
  operators: { choices: CHOICES_OPS, text: TEXT_OPS, number: NUMBER_OPS },
  toScalar: (value, path) => {
    if (isRootPath(path)) return optionList(value.optionIds);
    if (path === 'count') return countScalar(value.optionIds.length + (value.other !== undefined ? 1 : 0));
    return path === 'other' && value.other !== undefined ? { t: 'text', v: value.other } : NULL;
  },
  isEmpty: (value) => value.optionIds.length === 0 && (value.other ?? '') === '',
  columns: (block) => {
    const header = headerOf(block);
    return block.config.other?.enabled ? [{ suffix: '', header }, { suffix: '.other', header: `${header} (${block.config.other.label?.trim() || 'Other'})` }] : [{ suffix: '', header }];
  },
  cells: (value, block) => {
    const labels = value.optionIds.map((id) => optionLabel(block.config.options, id)).join(SEPARATOR);
    return block.config.other?.enabled ? [labels, value.other ?? ''] : [labels];
  },
  text: (value, block) => [...value.optionIds.map((id) => optionLabel(block.config.options, id)), ...(value.other !== undefined ? [value.other] : [])].join(SEPARATOR),
  texts: (block) => [...optionTexts(block.id, block.config.options), ...otherTexts(block.id, block.config.other), ...configTexts(block, ['placeholder'])],
  content: (block) => (block.config.other ? ['/config/options', '/config/other'] : ['/config/options']),
  hasDefault: (block) => (block.config.defaultOptionIds?.length ?? 0) > 0,
  lint: (block) => optionAltLint(block.id, block.config.options),
});
