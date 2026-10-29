import type { NamePart } from '@form/schema';
import { defineField, headerOf, isBlank } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const PARTS: readonly NamePart[] = ['prefix', 'first', 'middle', 'last', 'suffix'];

const joined = (value: Partial<Record<NamePart, string>>): string =>
  PARTS.map((part) => value[part]?.trim() ?? '').filter(Boolean).join(' ');

/** FLD-03. First and last name as two inputs; extra parts stay available on the config. */
export const fullName = defineField({
  type: 'full_name',
  palette: [entry('full_name', null, 'basic', PALETTE_LABELS['palette.full_name'], 'user', ['name', 'full name', 'first', 'last', 'contact', 'person'])],
  defaultConfig: () => ({ parts: ['first', 'last'], requiredParts: ['first', 'last'] }),
  checkConfig: (config, report) => {
    if (!config.parts.includes('first')) report('parts must include first', ['parts']);
    config.requiredParts.forEach((part, i) => {
      if (!config.parts.includes(part)) report('requiredParts must be listed in parts', ['requiredParts', i]);
    });
  },
  checkAnswer: (value, block, state, report) => {
    if (!state.required) return;
    for (const part of block.config.requiredParts) {
      if (isBlank(value[part])) report('required', [part]);
    }
  },
  paths: { '': 'text' },
  operators: { text: TEXT_OPS },
  toScalar: (value, path) => (isRootPath(path) ? { t: 'text', v: joined(value) } : NULL),
  isEmpty: (value) => isBlank(value),
  columns: (block) => {
    const header = headerOf(block);
    return block.config.parts.map((part) => ({ suffix: `.${part}`, header: `${header} / ${part}` }));
  },
  cells: (value, block) => block.config.parts.map((part) => value[part] ?? ''),
  text: (value) => joined(value),
});
