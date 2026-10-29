import { graphemeLength } from '@form/i18n';
import { configTexts, defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { NULL, entry, isRootPath, lengthCheck } from './shared.ts';

/** FLD-02 / VAL-02, in UTF-16 units; the answer twin enforces it. */
export const LONG_TEXT_MAX = 50_000;

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * Unicode White_Space (PropList.txt), listed by code point so word counts never depend on the host's `\s`
 * (BL-047): engines have disagreed on U+180E and U+FEFF, which are not White_Space. All are in the BMP.
 */
const WHITE_SPACE: ReadonlySet<number> = new Set([
  ...range(0x09, 0x0d), 0x20, 0x85, 0xa0, 0x1680, ...range(0x2000, 0x200a), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Runs of non-White_Space characters. */
export function wordCount(value: string): number {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < value.length; i += 1) {
    const space = WHITE_SPACE.has(value.charCodeAt(i));
    if (!space && !inWord) count += 1;
    inWord = !space;
  }
  return count;
}

export const longText = defineField({
  type: 'long_text',
  palette: [
    entry('long_text', 'address', 'basic', PALETTE_LABELS['palette.long_text.address'], 'map-pin', ['address', 'street', 'city', 'location', 'contact'], { placeholder: 'Street address' }),
    entry('long_text', null, 'basic', PALETTE_LABELS['palette.long_text'], 'align-left', ['text', 'long', 'paragraph', 'comment', 'multi-line']),
  ],
  defaultConfig: () => ({ rows: 4 }),
  checkConfig: (config, report) => {
    const limit = config.limit;
    if (limit?.min !== undefined && limit.max !== undefined && limit.min > limit.max) report('limit.min must not exceed limit.max', ['limit', 'min']);
    const fixed = config.defaultValue?.kind === 'static' ? config.defaultValue.value : undefined;
    if (fixed !== undefined && limit?.max !== undefined && (limit.unit === 'characters' ? graphemeLength(fixed) : wordCount(fixed)) > limit.max) {
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
    const count = wordCount(value);
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
