import { defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { PRESENCE_OPS } from '../operators.ts';
import { NULL, entry, isRootPath } from './shared.ts';

/** FLD-28. The image is an uploaded PNG (S10); a typed name is the accessible alternative. */
export const signature = defineField({
  type: 'signature',
  palette: [entry('signature', null, 'advanced', PALETTE_LABELS['palette.signature'], 'pen-line', ['signature', 'sign', 'autograph', 'consent'])],
  defaultConfig: () => ({ penColor: { token: 'text' }, heightPx: 160, allowTyped: true }),
  checkAnswer: (value, block, _state, report) => {
    if (value.method === 'typed') {
      if (!block.config.allowTyped) report('invalid_format', ['method']);
      if (!value.typedName?.trim()) report('required', ['typedName']);
    }
  },
  paths: { '': 'boolean' },
  operators: { boolean: PRESENCE_OPS },
  toScalar: (_value, path) => (isRootPath(path) ? { t: 'boolean', v: true } : NULL),
  isEmpty: () => false,
  cells: (value) => [value.typedName?.trim() || value.file.name],
  texts: (block) => (block.config.statement ? [`block:${block.id}:statement`] : []),
  content: (block) => (block.config.statement ? ['/config/statement'] : []),
});
