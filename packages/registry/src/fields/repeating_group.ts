import { REPEATABLE_BLOCK_TYPES } from '@form/schema';
import type { BlockId, RepeatableBlockType } from '@form/schema';
import { defineField, headerOf, isBlank } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { NUMBER_OPS } from '../operators.ts';
import { NULL, countScalar, entry, isRootPath } from './shared.ts';

const REPEATABLE = new Set<string>(REPEATABLE_BLOCK_TYPES);

const rowText = (values: Partial<Record<BlockId, { type?: string; value?: unknown }>>): string =>
  Object.values(values).map((answer) => {
    if (!answer || typeof answer !== 'object') return '';
    const value = answer.value;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    return value === undefined ? '' : JSON.stringify(value);
  }).filter(Boolean).join(', ');

/** FLD-25. A list the respondent grows while filling; one palette tile, authors add the fields they need. */
export const repeatingGroup = defineField({
  type: 'repeating_group',
  palette: [
    entry(
      'repeating_group',
      null,
      'advanced',
      PALETTE_LABELS['palette.repeating_group'],
      'list-plus',
      ['repeat', 'list', 'rows', 'dynamic', 'configurable', 'add row', 'group'],
    ),
  ],
  defaultConfig: () => ({ children: ['item' as BlockId], minRows: 0, maxRows: 10, initialRows: 1, layout: 'stacked' as const }),
  checkConfig: (config, report) => {
    if (config.minRows > config.maxRows) report('minRows must not exceed maxRows', ['minRows']);
    if (config.initialRows !== undefined && config.initialRows > config.maxRows) report('initialRows must not exceed maxRows', ['initialRows']);
    if (config.initialRows !== undefined && config.initialRows < config.minRows) report('initialRows must not be below minRows', ['initialRows']);
  },
  checkAnswer: (value, block, state, report) => {
    const ids = new Set(block.config.children);
    const seen = new Set<string>();
    value.rows.forEach((row, i) => {
      if (seen.has(row.rowId)) report('invalid_format', ['rows', i, 'rowId']);
      seen.add(row.rowId);
      for (const childId of Object.keys(row.values)) {
        if (!ids.has(childId as BlockId)) report('not_in_options', ['rows', i, 'values', childId]);
      }
    });
    if (value.rows.length > block.config.maxRows) report('too_many_rows');
    const need = state.required ? Math.max(block.config.minRows, 1) : block.config.minRows;
    if (value.rows.length < need) report('too_few_rows');
  },
  paths: { '': 'number', count: 'number' },
  operators: { number: NUMBER_OPS },
  toScalar: (value, path) => (isRootPath(path) || path === 'count' ? countScalar(value.rows.length) : NULL),
  isEmpty: (value) => value.rows.length === 0 || value.rows.every((row) => isBlank(row.values)),
  columns: (block) => [{ suffix: '', header: headerOf(block) }],
  cells: (value) => [value.rows.map((row) => rowText(row.values)).filter(Boolean).join(' | ')],
  texts: (block) => [
    ...(block.config.addLabel?.trim() ? [`block:${block.id}:addLabel` as const] : []),
    ...(block.config.removeLabel?.trim() ? [`block:${block.id}:removeLabel` as const] : []),
  ],
  content: () => ['/config/children'],
});

export const isRepeatableChildType = (type: string): type is RepeatableBlockType =>
  REPEATABLE.has(type) && type !== 'repeating_group';
