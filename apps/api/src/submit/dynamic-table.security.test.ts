import { bid, field, form, META, page, versionOf } from '@form/logic/test-corpus';
import type { AnswerValue, DynamicColumnId, Expr, FormDefinition, Locale } from '@form/schema';
import { describe, expect, it } from 'vitest';
import { checkAnswers } from '../validate-submission.ts';
import { withoutServerOwned } from './meta.ts';

/*
 * Review S1: a dynamic table's formula cells are the form's, like a calculation. The submit pipeline runs exactly
 * `checkAnswers(version, …, withoutServerOwned(definition, raw), …)`, which drops what the respondent sends for a formula
 * column and works the cell out again, so a forged line total never reaches the store or the summaries a formula reads.
 */

const NOW = new Date(META.now);
const LOCALE = 'en-IN' as Locale;
const col = (id: string) => id as DynamicColumnId;
const summary: Expr = { k: 'ref', ref: { kind: 'answer', blockId: bid('lines'), path: 'summary.sum.line' } };

const def = (): FormDefinition => form([
  field('dynamic_table', 'lines', {
    config: {
      columns: [
        { id: col('qty'), label: 'Qty', input: 'number' },
        { id: col('price'), label: 'Price', input: 'number' },
        { id: col('line'), label: 'Line', input: 'formula', formula: 'Qty * Price', summary: 'sum' },
      ],
      minRows: 0, maxRows: 10, allowAddColumns: true, addableInputs: ['text', 'number'], maxColumns: 10,
    },
  }),
  field('calculation', 'total', { config: { expr: summary, resultType: 'number', display: 'visible' } }),
], [page('p1', ['lines', 'total'])], []);

const submit = (raw: Record<string, unknown>) => {
  const version = versionOf(def());
  return checkAnswers(version, 'v1', withoutServerOwned(version.definition, raw), LOCALE, NOW);
};
const table = (rows: Array<Record<string, string>>, addedColumns?: unknown[]) =>
  ({ type: 'dynamic_table', value: { ...(addedColumns ? { addedColumns } : {}), rows: rows.map((cells, i) => ({ rowId: `row_${i + 1}`, cells })) } }) as unknown as AnswerValue;

describe('a forged formula cell in a dynamic table', () => {
  it('is replaced by the value the server works out, and the summary a calculation reads follows it', () => {
    const checked = submit({ lines: table([{ qty: '2', price: '10', line: '1' }, { qty: '3', price: '5', line: '999999' }]) });
    expect(checked.errors).toEqual([]);
    const stored = checked.values[bid('lines')] as { value: { rows: Array<{ cells: Record<string, string> }> } };
    expect(stored.value.rows.map((row) => row.cells['line'])).toEqual(['20', '15']);
    expect(checked.values[bid('total')]).toEqual({ type: 'calculation', value: { t: 'number', v: '35' } });
  });

  it('reads a missing cell as 0, as the renderer does', () => {
    const checked = submit({ lines: table([{ qty: '2', line: '5' }]) });
    expect(checked.errors).toEqual([]);
    const stored = checked.values[bid('lines')] as { value: { rows: Array<{ cells: Record<string, string> }> } };
    expect(stored.value.rows[0]?.cells).toEqual({ qty: '2', line: '0' });
  });

  it('a respondent cannot add a formula column of their own', () => {
    const checked = submit({ lines: table([{ qty: '1', price: '1', user_1: '5' }], [{ id: 'user_1', label: 'Mine', input: 'formula' }]) });
    expect(checked.errors.length).toBeGreaterThan(0);
    expect(checked.values[bid('lines')]).toBeUndefined();
  });
});
