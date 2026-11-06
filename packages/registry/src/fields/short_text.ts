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
    entry('short_text', 'fill_blank', 'basic', PALETTE_LABELS['palette.short_text.fill_blank'], 'type', ['fill in the blank', 'blank', 'underscore', 'sentence', 'complete'], { placeholder: '_____' }),
    entry('short_text', 'pan', 'advanced', PALETTE_LABELS['palette.short_text.pan'], 'hash', ['pan', 'income tax', 'india'], { preset: 'in_pan', placeholder: 'ABCDE1234F', maxLength: 10 }),
    entry('short_text', 'gstin', 'advanced', PALETTE_LABELS['palette.short_text.gstin'], 'hash', ['gstin', 'gst', 'tax', 'india'], { preset: 'in_gstin', placeholder: '22AAAAA0000A1Z5', maxLength: 15 }),
    entry('short_text', 'pincode', 'advanced', PALETTE_LABELS['palette.short_text.pincode'], 'map-pin', ['pin', 'pincode', 'postal', 'india'], { preset: 'in_pincode', placeholder: '411001', maxLength: 6 }),
    entry('short_text', 'ifsc', 'advanced', PALETTE_LABELS['palette.short_text.ifsc'], 'hash', ['ifsc', 'bank', 'india'], { preset: 'in_ifsc', placeholder: 'SBIN0000001', maxLength: 11 }),
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
