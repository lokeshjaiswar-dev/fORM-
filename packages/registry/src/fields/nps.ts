import { configTexts, defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { NUMBER_OPS } from '../operators.ts';
import { NULL, countScalar, entry, isRootPath } from './shared.ts';

/** FLD-22. 0–10 from the answer twin; 0 is a real answer and unanswered is absent (B7). */
export const nps = defineField({
  type: 'nps',
  palette: [entry('nps', null, 'rating', PALETTE_LABELS['palette.nps'], 'smile', ['nps', 'net promoter', 'recommend', 'score', 'loyalty'])],
  defaultConfig: () => ({}),
  paths: { '': 'number' },
  operators: { number: NUMBER_OPS },
  toScalar: (value, path) => (isRootPath(path) ? countScalar(value) : NULL),
  isEmpty: () => false,
  cells: (value) => [String(value)],
  texts: (block) => configTexts(block, ['lowLabel', 'highLabel']),
});
