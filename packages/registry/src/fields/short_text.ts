import { graphemeLength } from '@form/i18n';
import { configTexts, defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { NULL, entry, isRootPath, lengthCheck } from './shared.ts';

/** FLD-01. Lengths count grapheme clusters; pattern, preset and mask run in @form/validation (re2js). */
export const SHORT_TEXT_MAX = 10_000;

export const shortText = defineField({
  type: 'short_text',
  palette: [
    entry('short_text', null, 'basic', PALETTE_LABELS['palette.short_text'], 'type', ['text', 'short', 'answer', 'input', 'line']),
  ],
  defaultConfig: () => ({}),
  checkConfig: (config, report) => {
    if (config.minLength !== undefined && config.maxLength !== undefined && config.minLength > config.maxLength) {
      report('minLength must not exceed maxLength', ['minLength']);
    }
    const fixed = config.defaultValue?.kind === 'static' ? config.defaultValue.value : undefined;
    if (fixed !== undefined && graphemeLength(fixed) > (config.maxLength ?? SHORT_TEXT_MAX)) report('defaultValue is longer than maxLength', ['defaultValue', 'value']);
  },
  checkAnswer: (value, block, _state, report) =>
    lengthCheck(graphemeLength(value), block.config.minLength, block.config.maxLength ?? SHORT_TEXT_MAX, report),
  paths: { '': 'text' },
  operators: { text: [...TEXT_OPS, 'matches_preset'] },
  toScalar: (value, path) => (isRootPath(path) ? { t: 'text', v: value } : NULL),
  isEmpty: (value) => value === '',
  cells: (value) => [value],
  texts: (block) => configTexts(block, ['placeholder', 'prefix', 'suffix']),
  hasDefault: (block) => block.config.defaultValue !== undefined,
});
