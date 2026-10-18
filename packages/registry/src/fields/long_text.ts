import { graphemeLength } from '@form/i18n';
import { configTexts, defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { NULL, entry, isRootPath, lengthCheck } from './shared.ts';

/** FLD-02 / VAL-02, in UTF-16 units; the answer twin enforces it. */
export const LONG_TEXT_MAX = 50_000;

const words = (value: string): number => value.split(/\s+/u).filter((w) => w !== '').length;

export const longText = defineField({
  type: 'long_text',
  palette: [entry('long_text', null, 'basic', PALETTE_LABELS['palette.long_text'], 'align-left', ['text', 'long', 'paragraph', 'comment', 'multi-line'])],
  defaultConfig: () => ({ rows: 4 }),
  checkConfig: (config, report) => {
    const limit = config.limit;
    if (limit?.min !== undefined && limit.max !== undefined && limit.min > limit.max) report('limit.min must not exceed limit.max', ['limit', 'min']);
    const fixed = config.defaultValue?.kind === 'static' ? config.defaultValue.value : undefined;
    if (fixed !== undefined && limit?.max !== undefined && (limit.unit === 'characters' ? graphemeLength(fixed) : words(fixed)) > limit.max) {
      report('defaultValue exceeds limit.max', ['defaultValue', 'value']);
    }
  },
  checkAnswer: (value, block, _state, report) => {
    const limit = block.config.limit;
    if (!limit) return;
    const chars = graphemeLength(value);
    if (limit.unit === 'characters') {
      lengthCheck(chars, limit.min, limit.max, report);
      return;
    }
    const count = words(value);
    if (limit.min !== undefined && count < limit.min) report('too_few_words');
    if (limit.max !== undefined && count > limit.max) report('too_many_words');
  },
  paths: { '': 'text' },
  operators: { text: TEXT_OPS },
  toScalar: (value, path) => (isRootPath(path) ? { t: 'text', v: value } : NULL),
  isEmpty: (value) => value === '',
  cells: (value) => [value],
  texts: (block) => configTexts(block, ['placeholder']),
  hasDefault: (block) => block.config.defaultValue !== undefined,
});
