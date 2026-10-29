import type { MatrixColumn, MatrixColumnId, MatrixRowId } from '@form/schema';
import { defineField, headerOf, isBlank } from '../define.ts';
import { DEFAULT_TEXT, PALETTE_LABELS, message } from '../messages.ts';
import { PRESENCE_OPS } from '../operators.ts';
import { labelText } from '../util/text.ts';
import { NULL, countScalar, entry, isRootPath } from './shared.ts';

const noRows = (rows: object): boolean => Object.values(rows).every(isBlank);

const columnIds = (columns: readonly MatrixColumn[]): ReadonlySet<MatrixColumnId> => new Set(columns.map((c) => c.id));

const expectedInput = (mode: 'single' | 'multi' | 'grid'): MatrixColumn['input'] =>
  (mode === 'single' ? 'choice' : mode === 'multi' ? 'checkbox' : 'text');

/** FLD-24. Input table: one answer per row (single), several (multi), or a typed cell per column (grid). */
export const matrix = defineField({
  type: 'matrix',
  palette: [entry('matrix', null, 'rating', PALETTE_LABELS['palette.matrix'], 'table', ['matrix', 'table', 'input table', 'grid', 'likert', 'survey'])],
  defaultConfig: (locale) => ({
    mode: 'single',
    rows: [1, 2].map((n) => ({ id: `row_${n}` as MatrixRowId, label: message(locale, DEFAULT_TEXT['defaults.matrix_row'], { n }) })),
    columns: [1, 2, 3].map((n) => ({
      id: `column_${n}` as MatrixColumnId,
      label: message(locale, DEFAULT_TEXT['defaults.matrix_column'], { n }),
      input: 'choice' as const,
    })),
    requireEach: 'none',
  }),
  checkConfig: (config, report) => {
    const seenRows = new Set<string>();
    config.rows.forEach((row, i) => {
      if (seenRows.has(row.id)) report('row ids must be unique', ['rows', i, 'id']);
      seenRows.add(row.id);
    });
    const seenCols = new Set<string>();
    config.columns.forEach((col, i) => {
      if (seenCols.has(col.id)) report('column ids must be unique', ['columns', i, 'id']);
      seenCols.add(col.id);
      const want = expectedInput(config.mode);
      if (col.input !== want) report(`columns must use '${want}' input in ${config.mode} mode`, ['columns', i, 'input']);
    });
  },
  checkAnswer: (value, block, state, report) => {
    if (value.mode !== block.config.mode) {
      report('invalid_format');
      return;
    }
    const rows = new Set(block.config.rows.map((r) => r.id));
    const cols = columnIds(block.config.columns);
    const answered = Object.entries(value.rows);
    for (const [rowId, cell] of answered) {
      if (!rows.has(rowId as MatrixRowId)) report('not_in_options', ['rows', rowId]);
      if (value.mode === 'single') {
        if (!cols.has(cell as MatrixColumnId)) report('not_in_options', ['rows', rowId]);
      } else if (value.mode === 'multi') {
        const ids = cell as MatrixColumnId[];
        const seen = new Set<MatrixColumnId>();
        ids.forEach((id, i) => {
          if (!cols.has(id)) report('not_in_options', ['rows', rowId, i]);
          else if (seen.has(id)) report('invalid_format', ['rows', rowId, i]);
          seen.add(id);
        });
      } else {
        for (const colId of Object.keys(cell as object)) {
          if (!cols.has(colId as MatrixColumnId)) report('not_in_options', ['rows', rowId, colId]);
        }
      }
    }
    const needRows = state.required || block.config.requireEach === 'row' || block.config.requireEach === 'cell';
    if (needRows && answered.length < block.config.rows.length) report('too_few_selected');
    if (block.config.requireEach === 'cell' && value.mode === 'grid') {
      for (const row of block.config.rows) {
        const cells = (value.rows[row.id] ?? {}) as Record<string, unknown>;
        if (block.config.columns.some((col) => isBlank(cells[col.id]))) report('too_few_selected', ['rows', row.id]);
      }
    }
  },
  paths: { '': 'number' },
  operators: { number: PRESENCE_OPS },
  toScalar: (value, path) => (isRootPath(path) ? countScalar(Object.keys(value.rows).length) : NULL),
  isEmpty: (value) => noRows(value.rows),
  columns: (block) => {
    const header = headerOf(block);
    return block.config.rows.map((row) => ({ suffix: `.${row.id}`, header: `${header} / ${labelText(row.label)}` }));
  },
  cells: (value, block) => block.config.rows.map((row) => {
    const cell = value.rows[row.id];
    if (cell === undefined) return '';
    if (value.mode === 'single') return block.config.columns.find((c) => c.id === cell)?.label ?? String(cell);
    if (value.mode === 'multi') {
      return (cell as MatrixColumnId[]).map((id) => block.config.columns.find((c) => c.id === id)?.label ?? id).join('; ');
    }
    return Object.entries(cell as Record<string, unknown>).map(([id, v]) => `${block.config.columns.find((c) => c.id === id)?.label ?? id}: ${String(v)}`).join('; ');
  }),
  texts: (block) => [
    ...block.config.rows.flatMap((row) => (typeof row.label === 'string' && row.label.trim() ? [`mrow:${block.id}/${row.id}` as const] : [])),
    ...block.config.columns.flatMap((col) => (col.label.trim() ? [`mcol:${block.id}/${col.id}` as const] : [])),
  ],
  content: () => ['/config/rows', '/config/columns'],
});
