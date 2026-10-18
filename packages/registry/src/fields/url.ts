import { configTexts, defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { asciiLower } from '../util/text.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const URL_SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^\s/?#]+)(?:[/?#]\S*)?$/u;
/** A host with at least one dot and an optional port; no credentials (`user@host`). */
const HOST = /^[^\s:@.][^\s:@]*\.[^\s:@]*[^\s:@.](?::\d{1,5})?$/u;

/** FLD-09: an absolute link whose scheme the block allows. */
export const url = defineField({
  type: 'url',
  palette: [entry('url', null, 'contact', PALETTE_LABELS['palette.url'], 'link', ['url', 'link', 'website', 'web'])],
  defaultConfig: () => ({ schemes: ['https', 'http'] }),
  checkAnswer: (value, block, _state, report) => {
    const match = URL_SHAPE.exec(value);
    const scheme = asciiLower(match?.[1] ?? '');
    const schemes: readonly string[] = block.config.schemes;
    if (!match || !schemes.includes(scheme) || !HOST.test(match[2] ?? '')) report('invalid_url');
  },
  paths: { '': 'text' },
  operators: { text: TEXT_OPS },
  toScalar: (value, path) => (isRootPath(path) ? { t: 'text', v: value } : NULL),
  isEmpty: (value) => value === '',
  cells: (value) => [value],
  texts: (block) => configTexts(block, ['placeholder', 'prefix', 'suffix']),
  hasDefault: (block) => block.config.defaultValue !== undefined,
});
