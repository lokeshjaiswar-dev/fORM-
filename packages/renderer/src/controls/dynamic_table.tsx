import { useEffect, useState } from 'react';
import { summarize, withFormulaCells } from '@form/registry';
import type { DynamicAddableInput, DynamicColumnId, DynamicColumnInput, DynamicSummary, DynamicTableValue, GroupRowId } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { useAnswer, type ControlProps } from './hooks.ts';
import { DynamicCellInput, DynamicTableFrame, type FrameColumn, type FrameRow } from './dynamic_table_frame.tsx';
import { NativeSelect } from './native.tsx';

type Value = DynamicTableValue;
type Added = NonNullable<Value['addedColumns']>[number];

const SUMMARY_LABEL: Record<Exclude<DynamicSummary, 'none'>, keyof typeof MESSAGES> = {
  sum: 'dtable.sum',
  average: 'dtable.average',
  min: 'dtable.min',
  max: 'dtable.max',
  count: 'dtable.count',
};

const TYPE_LABEL: Record<DynamicColumnInput, keyof typeof MESSAGES> = {
  text: 'dtable.column_text',
  long_text: 'dtable.column_long_text',
  number: 'dtable.column_number',
  date: 'dtable.column_date',
  datetime: 'dtable.column_datetime',
  time: 'dtable.column_time',
  email: 'dtable.column_email',
  url: 'dtable.column_url',
  phone: 'dtable.column_phone',
  formula: 'dtable.column_formula',
};

/** The next `<prefix><n>` id that no existing id uses. */
function nextId(prefix: string, used: readonly string[]): string {
  let n = used.length + 1;
  while (used.includes(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

const formatNumber = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/**
 * FLD-25 + FLD-24 combined. Authors define the columns; rows are added within min/max. When allowed, a respondent can
 * add columns of the permitted types (up to `maxColumns`) from the top-right action. Summary columns get a footer row.
 */
export function DynamicTable({ block, field }: ControlProps<'dynamic_table'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const c = block.config;
  const locked = field.disabled || field.readOnly;
  const value: Value = answer.value ?? { rows: [] };
  const rows = value.rows;
  const added = value.addedColumns ?? [];
  const initial = c.initialRows ?? Math.max(c.minRows, 1);
  const addable = c.addableInputs;
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newType, setNewType] = useState<DynamicAddableInput>(addable[0] ?? 'text');

  useEffect(() => {
    if (answer.value === undefined && initial > 0) {
      answer.set({ rows: Array.from({ length: initial }, (_, i) => ({ rowId: `row_${i + 1}` as GroupRowId, cells: {} })) });
    }
  }, [answer.value, answer.set, initial]);

  const columns = [
    ...c.columns.map((col) => ({ id: col.id as string, label: col.label, input: col.input, summary: col.summary, added: false })),
    ...added.map((col) => ({ id: col.id as string, label: col.label, input: col.input, summary: undefined, added: true })),
  ];

  /** An empty table holds no answer (I9), so dropping the last row also drops respondent columns. */
  const write = (next: Value) => {
    if (next.rows.length === 0) answer.set(undefined);
    else answer.set(next.addedColumns?.length ? next : { rows: next.rows });
  };

  const formulaColumns = c.columns.filter((col) => col.input === 'formula');
  const rowSnapshot = JSON.stringify(rows);
  /* Formulas name other columns by label, so every column's label counts. */
  const formulaSnapshot = formulaColumns.length ? JSON.stringify(c.columns) : '';
  useEffect(() => {
    if (formulaColumns.length === 0 || rows.length === 0) return;
    /* The same cells the server works out and keeps (withFormulaCells): a typed value never stands in a formula column. */
    const nextRows = rows.map((row) => ({ ...row, cells: withFormulaCells(row.cells, c.columns) }));
    if (nextRows.some((row, i) => JSON.stringify(row.cells) !== JSON.stringify(rows[i]?.cells))) {
      write({ ...value, rows: nextRows });
    }
    // rowSnapshot and formulaSnapshot cover the inputs this recomputes from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formulaSnapshot, rowSnapshot]);

  const setCell = (index: number, colId: string, cell: string) => {
    const next = rows.map((row, i) => {
      if (i !== index) return row;
      const cells = { ...row.cells };
      if (cell === '') delete cells[colId as DynamicColumnId];
      else cells[colId as DynamicColumnId] = cell;
      return { ...row, cells };
    });
    write({ ...value, rows: next });
  };

  const addRow = () => {
    if (locked || rows.length >= c.maxRows) return;
    const rowId = nextId('row_', rows.map((r) => r.rowId)) as GroupRowId;
    write({ ...value, rows: [...rows, { rowId, cells: {} }] });
  };

  const removeRow = (index: number) => {
    if (locked || rows.length <= c.minRows) return;
    write({ ...value, rows: rows.filter((_, i) => i !== index) });
  };

  const canAddColumn = !locked && c.allowAddColumns && addable.length > 0 && columns.length < c.maxColumns;

  const addColumn = () => {
    const label = newLabel.trim();
    if (!canAddColumn || label === '') return;
    const id = nextId('user_', columns.map((col) => col.id)) as DynamicColumnId;
    const column: Added = { id, label, input: newType };
    // A column only exists alongside a row, so an empty table gets one row first.
    const base = rows.length === 0 ? [{ rowId: 'row_1' as GroupRowId, cells: {} }] : rows;
    write({ rows: base, addedColumns: [...added, column] });
    setNewLabel('');
    setAdding(false);
  };

  const removeAddedColumn = (id: string) => {
    if (locked) return;
    const nextRows = rows.map((row) => {
      const cells = { ...row.cells };
      delete cells[id as DynamicColumnId];
      return { ...row, cells };
    });
    write({ rows: nextRows, addedColumns: added.filter((col) => col.id !== id) });
  };

  const removable = rows.length > c.minRows && !locked;
  const hasFooter = c.columns.some((col) => col.summary && col.summary !== 'none');

  const frameColumns: FrameColumn[] = columns.map((col) => ({
    key: col.id,
    label: col.label,
    onRemove: col.added && !locked ? () => removeAddedColumn(col.id) : undefined,
    removeLabel: t(MESSAGES['dtable.remove_column']),
  }));

  const frameRows: FrameRow[] = rows.map((row, index) => ({
    key: row.rowId,
    cells: columns.map((col, ci) => (
      <DynamicCellInput
        key={col.id}
        type={col.input}
        id={ci === 0 && index === 0 ? field.ids.input : undefined}
        label={`${col.label} ${index + 1}`}
        value={row.cells[col.id as DynamicColumnId] ?? ''}
        disabled={field.disabled}
        readOnly={field.readOnly || col.input === 'formula'}
        onChange={col.input === 'formula' ? undefined : (v) => setCell(index, col.id, v)}
        onBlur={answer.onBlur}
      />
    )),
    action: removable ? (
      <button type="button" className="fr-repeat-remove" aria-label={`${t(MESSAGES['repeat.remove'])} ${t(MESSAGES['repeat.row'], { n: index + 1 })}`} onClick={() => removeRow(index)}>
        {t(MESSAGES['repeat.remove'])}
      </button>
    ) : undefined,
  }));

  const footer = hasFooter
    ? columns.map((col) => {
        const summary = c.columns.find((x) => x.id === col.id)?.summary;
        if (!summary || summary === 'none') return null;
        const result = summarize(rows, { id: col.id as DynamicColumnId, label: col.label, input: col.input as DynamicColumnInput, summary });
        const name = c.columns.find((x) => x.id === col.id)?.summaryLabel?.trim() || t(MESSAGES[SUMMARY_LABEL[summary]]);
        return result === undefined ? null : `${name}: ${formatNumber(result)}`;
      })
    : null;

  const toolbar = adding ? (
    <>
      <input
        className="fr-input fr-dtable-new-name"
        type="text"
        aria-label={t(MESSAGES['dtable.column_name'])}
        placeholder={t(MESSAGES['dtable.column_name'])}
        value={newLabel}
        maxLength={100}
        onChange={(e) => setNewLabel(e.target.value)}
      />
      {addable.length > 1 ? (
        <NativeSelect
          className="fr-dtable-new-type"
          value={newType}
          allowEmpty={false}
          onChange={(v) => setNewType(v as DynamicAddableInput)}
          options={addable.map((type) => ({ value: type, label: t(MESSAGES[TYPE_LABEL[type]]) }))}
          aria-label={t(MESSAGES['dtable.column_type'])}
        />
      ) : null}
      <button type="button" className="fr-repeat-add" onClick={addColumn} disabled={newLabel.trim() === ''}>
        {t(MESSAGES['dtable.add_column'])}
      </button>
      <button type="button" className="fr-link-button" onClick={() => setAdding(false)}>
        {t(MESSAGES['dtable.cancel'])}
      </button>
    </>
  ) : canAddColumn ? (
    <button type="button" className="fr-repeat-add" onClick={() => setAdding(true)}>
      {t(MESSAGES['dtable.add_column'])}
    </button>
  ) : null;

  return (
    <DynamicTableFrame
      columns={frameColumns}
      rows={frameRows}
      footer={footer}
      toolbar={toolbar}
      belowRows={!locked && rows.length < c.maxRows ? (
        <button type="button" className="fr-repeat-add" onClick={addRow}>
          {t(MESSAGES['repeat.add'])}
        </button>
      ) : null}
    />
  );
}

