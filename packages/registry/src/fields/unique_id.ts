import type { UniqueIdConfig } from '@form/schema';
import { defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { NULL, entry, isRootPath } from './shared.ts';

export function formatUniqueId(config: UniqueIdConfig, n = config.startAt): string {
  const prefix = config.prefix.map((part) => (typeof part === 'string' ? part : '')).join('');
  return `${prefix}${String(Math.max(0, n)).padStart(config.padTo, '0')}`;
}

/** FLD-32. Server-assigned serial; the client shows a preview from prefix + startAt. */
export const uniqueId = defineField({
  type: 'unique_id',
  kind: 'computed',
  palette: [entry('unique_id', null, 'advanced', PALETTE_LABELS['palette.unique_id'], 'hash', ['unique id', 'serial', 'ticket', 'application number', 'reference'])],
  defaultConfig: () => ({ prefix: [], padTo: 6, startAt: 1, resetEvery: 'never', showOnEnding: true }),
  checkConfig: (config, report) => {
    if (config.padTo < 1) report('padTo must be at least 1', ['padTo']);
    if (config.startAt < 0) report('startAt must not be negative', ['startAt']);
  },
  paths: { '': 'text' },
  operators: { text: TEXT_OPS },
  toScalar: (value, path) => (isRootPath(path) ? { t: 'text', v: value } : NULL),
  isEmpty: (value) => value === '',
  cells: (value) => [value],
  hasDefault: () => true,
});
