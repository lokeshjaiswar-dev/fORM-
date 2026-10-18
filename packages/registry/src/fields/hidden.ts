import { defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { NULL, entry, isRootPath } from './shared.ts';

/** FLD-30. Always has a source, so it captures something (B26); compliance default is under review. */
export const hidden = defineField({
  type: 'hidden',
  palette: [entry('hidden', null, 'advanced', PALETTE_LABELS['palette.hidden'], 'eye-off', ['hidden', 'utm', 'url parameter', 'tracking', 'prefill'])],
  defaultConfig: () => ({ source: { kind: 'url_param' } }),
  paths: { '': 'text' },
  operators: { text: TEXT_OPS },
  toScalar: (value, path) => (isRootPath(path) ? { t: 'text', v: value } : NULL),
  isEmpty: (value) => value === '',
  cells: (value) => [value],
  hasDefault: () => true,
});
