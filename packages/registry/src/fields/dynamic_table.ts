import type { DecimalString, DynamicColumnId, DynamicSummary, DynamicTableColumn, DynamicTableValue } from '@form/schema';
import { defineField, headerOf, isBlank } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { NUMBER_OPS } from '../operators.ts';
import { labelText } from '../util/text.ts';
import { NULL, countScalar, entry, isRootPath } from './shared.ts';

const DECIMAL = /^-?\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ()-]{4,20}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const TIME = /^\d{2}:\d{2}/;

/** Every column a respondent sees: the authored ones, then any they added. */
const allColumns = (value: DynamicTableValue, columns: readonly DynamicTableColumn[]) => [
  ...columns.map((c) => ({ id: c.id as string, label: c.label, input: c.input as string })),
  ...(value.addedColumns ?? []).map((c) => ({ id: c.id as string, label: c.label, input: c.input as string })),
];

/** An absolute http(s) address with a host; the registry has no DOM `URL` (it runs in the API and the worker too). */
const URL_CELL = /^https?:\/\/[^\s/?#]+[^\s]*$/i;

/** The pattern a cell of each input kind must match; text and long text take anything. */
const CELL_PATTERN: Readonly<Partial<Record<string, RegExp>>> = {
  number: DECIMAL, formula: DECIMAL, date: ISO_DATE, email: EMAIL, phone: PHONE, datetime: DATETIME, time: TIME, url: URL_CELL,
};
const cellValid = (input: string, cell: string): boolean => !Object.hasOwn(CELL_PATTERN, input) || CELL_PATTERN[input]!.test(cell);

/** Numeric cells of one column (non-blank, parsed). */
export const columnNumbers = (rows: DynamicTableValue['rows'], id: string): number[] =>
  rows.flatMap((row) => {
    const cell = row.cells[id as DynamicColumnId];
    return cell !== undefined && DECIMAL.test(cell) ? [Number(cell)] : [];
  });

const NAME_KEY = /^(?:c\d+)/;

/**
 * A row formula (`qty * price`) using other columns' labels. Names are replaced with `c0`, `c1`, … before parsing.
 * Missing or non-numeric cells count as 0. Returns undefined when the text is empty or not a valid formula.
 */
export function evaluateRowFormula(formula: string, valuesByName: ReadonlyMap<string, number>): number | undefined {
  const names = [...valuesByName.keys()].filter((n) => n.trim() !== '').sort((a, b) => b.length - a.length);
  const keys = new Map(names.map((name, i) => [name, `c${i}`]));
  const numbers = new Map<string, number>();
  for (const [name, key] of keys) numbers.set(key, valuesByName.get(name) ?? 0);
  let text = formula;
  if (names.length > 0) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
    text = formula.replace(pattern, (m) => keys.get(m) ?? m);
  }
  const src = text.trim();
  if (!src) return undefined;
  let i = 0;
  const peek = () => src[i] ?? '';
  const skip = () => { while (src[i] === ' ') i += 1; };
  const primary = (): number | undefined => {
    skip();
    if (peek() === '(') {
      i += 1;
      const inner = expr();
      skip();
      if (inner === undefined || peek() !== ')') return undefined;
      i += 1;
      return inner;
    }
    const rest = src.slice(i);
    const num = /^(0|[1-9]\d*)(?:\.\d{1,10})?/.exec(rest);
    if (num) { i += num[0].length; return Number(num[0]); }
    const key = NAME_KEY.exec(rest);
    if (key && numbers.has(key[0])) { i += key[0].length; return numbers.get(key[0]) ?? 0; }
    return undefined;
  };
  const unary = (): number | undefined => {
    skip();
    if (peek() === '-') { i += 1; const v = unary(); return v === undefined ? undefined : -v; }
    return primary();
  };
  const term = (): number | undefined => {
    let left = unary();
    if (left === undefined) return undefined;
    for (;;) {
      skip();
      const op = peek();
      if (op !== '*' && op !== '/') break;
      i += 1;
      const right = unary();
      if (right === undefined) return undefined;
      if (op === '/' && right === 0) return undefined;
      left = op === '*' ? left * right : left / right;
    }
    return left;
  };
  const expr = (): number | undefined => {
    let left = term();
    if (left === undefined) return undefined;
    for (;;) {
      skip();
      const op = peek();
      if (op !== '+' && op !== '-') break;
      i += 1;
      const right = term();
      if (right === undefined) return undefined;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };
  const result = expr();
  skip();
  if (result === undefined || i < src.length || !Number.isFinite(result)) return undefined;
  return Math.round(result * 1e10) / 1e10;
}

/** A formula result as the cell shows it: whole numbers as they are, others to two places. */
const formulaText = (n: number): string | undefined => {
  const text = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  return DECIMAL.test(text) ? text : undefined;
};

/**
 * One row's cells with every authored formula column worked out from the other cells (review S1). Whatever the row held
 * in a formula column is dropped first: the renderer shows these cells read-only and the server recomputes them, so a
 * respondent's value never stands. Formulas may read other formula columns, so the pass repeats once per formula.
 * Cells that are not strings (an answer not yet validated) read as 0 and are otherwise left for validation to report.
 */
export function withFormulaCells<C extends Readonly<Record<string, unknown>>>(cells: C, columns: readonly DynamicTableColumn[]): C {
  const formulas = columns.filter((col) => col.input === 'formula');
  if (formulas.length === 0) return cells;
  const out: Record<string, unknown> = { ...cells };
  for (const col of formulas) delete out[col.id];
  const active = formulas.filter((col) => (col.formula ?? '').trim() !== '');
  for (let pass = 0; pass < active.length; pass += 1) {
    for (const col of active) {
      const values = new Map<string, number>();
      for (const other of columns) {
        if (other.id === col.id) continue;
        const raw = out[other.id];
        values.set(other.label, typeof raw === 'string' && DECIMAL.test(raw) ? Number(raw) : 0);
      }
      const result = evaluateRowFormula(col.formula ?? '', values);
      const text = result === undefined ? undefined : formulaText(result);
      if (text === undefined) delete out[col.id];
      else out[col.id] = text;
    }
  }
  return out as C;
}

/** The footer value of a column. `count` counts filled cells; the rest need at least one number. */
export function summarize(rows: DynamicTableValue['rows'], column: DynamicTableColumn): number | undefined {
  const filled = rows.filter((row) => row.cells[column.id] !== undefined).length;
  if (column.summary === 'count') return filled;
  const nums = columnNumbers(rows, column.id);
  if (nums.length === 0 || !column.summary || column.summary === 'none') return undefined;
  switch (column.summary) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'average': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
    default: return undefined;
  }
}

/** FLD-25 + FLD-24 combined. An authored list of columns, rows the respondent adds, optional per-column summary. */
export const dynamicTable = defineField({
  type: 'dynamic_table',
  palette: [
    entry(
      'dynamic_table',
      null,
      'advanced',
      PALETTE_LABELS['palette.dynamic_table'],
      'table',
      ['dynamic', 'table', 'input table', 'configurable list', 'rows', 'columns', 'sum', 'total', 'summary', 'grid'],
    ),
  ],
  defaultConfig: () => ({
    columns: [
      { id: 'column_1' as DynamicColumnId, label: 'Item', input: 'text' as const },
      { id: 'column_2' as DynamicColumnId, label: 'Amount', input: 'number' as const, summary: 'sum' as const },
    ],
    minRows: 0,
    maxRows: 10,
    initialRows: 1,
    allowAddColumns: false,
    addableInputs: ['text', 'number'],
    maxColumns: 10,
  }),
  checkConfig: (config, report) => {
    const seen = new Set<string>();
    config.columns.forEach((col, i) => {
      if (seen.has(col.id)) report('column ids must be unique', ['columns', i, 'id']);
      seen.add(col.id);
      if (col.summary && col.summary !== 'none' && col.input !== 'number' && col.input !== 'formula' && col.summary !== 'count') {
        report('a summary needs a number column', ['columns', i, 'summary']);
      }
    });
    if (config.minRows > config.maxRows) report('minRows must not exceed maxRows', ['minRows']);
    if (config.initialRows !== undefined && config.initialRows > config.maxRows) report('initialRows must not exceed maxRows', ['initialRows']);
    if (config.initialRows !== undefined && config.initialRows < config.minRows) report('initialRows must not be below minRows', ['initialRows']);
    if (config.maxColumns < config.columns.length) report('maxColumns must not be below the number of columns', ['maxColumns']);
  },
  checkAnswer: (value, block, state, report) => {
    const { columns, maxRows, minRows, allowAddColumns, addableInputs, maxColumns } = block.config;
    const added = value.addedColumns ?? [];
    if (added.length > 0 && !allowAddColumns) report('not_in_options', ['addedColumns']);
    added.forEach((col, i) => {
      if (!addableInputs.includes(col.input)) report('not_in_options', ['addedColumns', i, 'input']);
    });
    if (columns.length + added.length > maxColumns) report('too_many_selected', ['addedColumns']);
    const colIds = new Set<string>();
    for (const col of allColumns(value, columns)) {
      if (colIds.has(col.id)) report('invalid_format', ['addedColumns']);
      colIds.add(col.id);
    }
    const known = new Map(allColumns(value, columns).map((c) => [c.id, c] as const));
    if (value.rows.length > maxRows) report('too_many_rows');
    const need = state.required ? Math.max(minRows, 1) : minRows;
    if (value.rows.length < need) report('too_few_rows');
    const seen = new Set<string>();
    value.rows.forEach((row, i) => {
      if (seen.has(row.rowId)) report('invalid_format', ['rows', i, 'rowId']);
      seen.add(row.rowId);
      for (const [colId, cell] of Object.entries(row.cells)) {
        const col = known.get(colId);
        if (!col) {
          report('not_in_options', ['rows', i, 'cells', colId]);
        } else if (cell !== undefined && !cellValid(col.input, cell)) {
          report('invalid_format', ['rows', i, 'cells', colId]);
        }
      }
    });
  },
  paths: { '': 'number', count: 'number' },
  operators: { number: NUMBER_OPS },
  toScalar: (value, path) => {
    if (isRootPath(path) || path === 'count') return countScalar(value.rows.length);
    const summary = /^summary\.(sum|average|min|max|count)\.(.+)$/.exec(path ?? '');
    if (!summary) return NULL;
    const result = summarize(value.rows, { id: summary[2] as DynamicColumnId, label: '', input: 'number', summary: summary[1] as DynamicSummary });
    if (result === undefined) return NULL;
    const rounded = Math.round(result * 1e10) / 1e10;
    return { t: 'number', v: String(rounded) as DecimalString };
  },
  isEmpty: (value) => value.rows.every((row) => isBlank(row.cells)) && (value.addedColumns ?? []).length === 0,
  /* Respondent-added columns differ per response, so they share one column: `Label: value` per row (review S5). */
  columns: (block) => [
    ...block.config.columns.map((col) => ({ suffix: `.${col.id}`, header: `${headerOf(block)} / ${labelText(col.label)}` })),
    ...(block.config.allowAddColumns ? [{ suffix: '.added', header: `${headerOf(block)} / added columns` }] : []),
  ],
  cells: (value, block) => [
    ...block.config.columns.map((col) => value.rows.map((row) => row.cells[col.id] ?? '').filter((c) => c !== '').join('; ')),
    ...(block.config.allowAddColumns ? [value.rows
      .map((row) => (value.addedColumns ?? []).flatMap((col) => (row.cells[col.id] ? [`${col.label}: ${row.cells[col.id]}`] : [])).join(', '))
      .filter((c) => c !== '')
      .join('; ')] : []),
  ],
  text: (value, block) => value.rows
    .map((row) => allColumns(value, block.config.columns).map((col) => `${col.label}: ${row.cells[col.id as DynamicColumnId] ?? ''}`).join(', '))
    .join('\n'),
  texts: () => [],
  content: () => ['/config/columns'],
});
