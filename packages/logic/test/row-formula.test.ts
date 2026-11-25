import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { REGISTRY } from '@form/registry';
import { compile, createEvaluator, evaluate } from '../src/index.ts';
import { META, a, bid, cond, field, form, hide, page, rule, versionOf } from './build.ts';

/* A reference to a field in the same list row (the formula's own row). */
const inRow = (blockId: string): S.Expr => ({ k: 'ref', ref: { kind: 'answer', blockId: bid(blockId), row: 'current' } });
const times: S.Expr = { k: 'binary', op: '*', left: inRow('rate'), right: inRow('unit') };
const divide: S.Expr = { k: 'binary', op: '/', left: inRow('rate'), right: inRow('unit') };

/* A list of items; each row has a quantity (unit) and a price (rate), and a formula that combines them per row. */
function listForm(expr: S.Expr) {
  return form(
    [
      field('repeating_group', 'items', { config: { children: [bid('unit'), bid('rate'), bid('total')], minRows: 0, maxRows: 10, initialRows: 1, layout: 'stacked' } }),
      field('number', 'unit'),
      field('number', 'rate'),
      field('calculation', 'total', { config: { expr, resultType: 'number', display: 'visible' } }),
    ],
    [page('p1', ['items'])],
  );
}

const rows = () => a.group([
  { rowId: 'row_1', values: { [bid('unit')]: a.number('3'), [bid('rate')]: a.number('50') } },
  { rowId: 'row_2', values: { [bid('unit')]: a.number('2'), [bid('rate')]: a.number('10') } },
  { rowId: 'row_3', values: {} },
]);

describe('formula inside a repeating-group row', () => {
  it('computes each row from its own values', () => {
    const state = evaluate(versionOf(listForm(times)), { [bid('items')]: rows() }, META, 'client');
    expect(state.rowValues?.[bid('total')]).toEqual({
      row_1: { t: 'number', v: '150' },
      row_2: { t: 'number', v: '20' },
      row_3: { t: 'null' },
    });
  });

  it('keeps row results out of the form-level answers', () => {
    const state = evaluate(versionOf(listForm(times)), { [bid('items')]: rows() }, META, 'client');
    expect(state.values[bid('total')]).toBeUndefined();
  });

  it('gives no per-row result while the list has no rows', () => {
    const state = evaluate(versionOf(listForm(times)), {}, META, 'client');
    expect(state.rowValues?.[bid('total')]).toBeUndefined();
  });

  it('division per row gives null for a row whose divisor is zero', () => {
    const answers = {
      [bid('items')]: a.group([
        { rowId: 'row_1', values: { [bid('unit')]: a.number('4'), [bid('rate')]: a.number('10') } },
        { rowId: 'row_2', values: { [bid('unit')]: a.number('0'), [bid('rate')]: a.number('10') } },
      ]),
    };
    const state = evaluate(versionOf(listForm(divide)), answers, META, 'client');
    expect(state.rowValues?.[bid('total')]).toEqual({ row_1: { t: 'number', v: '2.5' }, row_2: { t: 'null' } });
  });

  it('incremental update matches a full evaluation after a row changes', () => {
    const version = versionOf(listForm(times));
    const session = createEvaluator(version, META, 'client');
    session.evaluate({ [bid('items')]: rows() });
    const changed = a.group([
      { rowId: 'row_1', values: { [bid('unit')]: a.number('5'), [bid('rate')]: a.number('50') } },
      { rowId: 'row_2', values: { [bid('unit')]: a.number('2'), [bid('rate')]: a.number('10') } },
      { rowId: 'row_3', values: {} },
    ]);
    const incremental = session.update({ [bid('items')]: changed }, [bid('items')]);
    const full = evaluate(version, { [bid('items')]: changed }, META, 'client');
    expect(incremental.rowValues).toEqual(full.rowValues);
    expect(incremental.rowValues?.[bid('total')]?.row_1).toEqual({ t: 'number', v: '250' });
  });

  it('a formula outside the list can sum the per-row results', () => {
    const def = form(
      [
        field('repeating_group', 'items', { config: { children: [bid('unit'), bid('rate'), bid('total')], minRows: 0, maxRows: 10, initialRows: 1, layout: 'stacked' } }),
        field('number', 'unit'),
        field('number', 'rate'),
        field('calculation', 'total', { config: { expr: times, resultType: 'number', display: 'visible' } }),
        field('calculation', 'tax', {
          config: { expr: { k: 'binary', op: '*', left: { k: 'call', fn: 'sum', args: [{ k: 'ref', ref: { kind: 'answer', blockId: bid('total') } }] }, right: { k: 'lit', value: { type: 'number', value: '0.18' as S.DecimalString } } }, resultType: 'number', display: 'visible' },
        }),
      ],
      [page('p1', ['items', 'tax'])],
    );
    const state = evaluate(versionOf(def), { [bid('items')]: rows() }, META, 'client');
    expect(state.values[bid('tax')]).toEqual({ type: 'calculation', value: { t: 'number', v: '30.6' } });
  });

  it('the whole form compiles with a per-row formula in a list', () => {
    expect(compile(listForm(times), REGISTRY).ok).toBe(true);
  });

  it('a same-row reference outside a list does not compile', () => {
    const def = form(
      [field('number', 'rate'), field('number', 'unit'), field('calculation', 'total', { config: { expr: times, resultType: 'number', display: 'visible' } })],
      [page('p1', ['rate', 'unit', 'total'])],
    );
    const result = compile(def, REGISTRY);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toContain('expr_type_error');
  });

  it('a same-row reference is not allowed in a rule', () => {
    const def = listForm(times);
    const withRule = { ...def, logic: { ...def.logic, rules: [rule('r1', cond({ kind: 'ref', ref: { kind: 'answer', blockId: bid('rate'), row: 'current' } }, 'is_answered'), [hide('total')])] } };
    expect(compile(withRule, REGISTRY).ok).toBe(false);
  });
});
