import { a, ans, bid, cond, field, form, id, META, oid, page, rule, versionOf } from '@form/logic/test-corpus';
import type { Action, AnswerValue, DecimalString, Expr, FormDefinition, Locale } from '@form/schema';
import { describe, expect, it } from 'vitest';
import { checkAnswers } from '../validate-submission.ts';
import { withoutServerOwned } from './meta.ts';

/*
 * WP-2.01 (founder, 25 Nov 2026): a field a rule sets (set, percent, fill from an option) is the form's, like a
 * calculation. The submit pipeline drops what the respondent sends for it and evaluates again (pipeline.ts runs exactly
 * `checkAnswers(version, …, withoutServerOwned(definition, raw), …)`), so a forged value never reaches the store: where
 * the rule writes, the server's value stands; where it does not, the field is empty.
 */

const NOW = new Date(META.now);
const LOCALE = 'en-IN' as Locale;
const ref = (blockId: string): Expr => ({ k: 'ref', ref: { kind: 'answer', blockId: bid(blockId) } });
const n = (v: string): Expr => ({ k: 'lit', value: { type: 'number', value: v as DecimalString } });
const set = (target: string, value: Expr): Action => ({ type: 'set_value', target: bid(target), value });

/** A menu dropdown filling `price` (read-only) from the option code, and `fee` set to 10% of `amount` when it is answered. */
const def = (): FormDefinition => form([
  field('single_choice', 'menu', { config: { display: 'dropdown', options: [{ id: oid('burger'), label: 'Burger', code: '467' }] } }),
  field('short_text', 'price', { readOnly: true }),
  field('number', 'amount'),
  field('number', 'fee'),
  field('repeating_group', 'items', { config: { children: [bid('item'), bid('row_price'), bid('qty')], minRows: 0, maxRows: 5, initialRows: 1, layout: 'stacked' } }),
  field('single_choice', 'item', { config: { display: 'dropdown', options: [{ id: oid('tea'), label: 'Tea', code: '20' }] } }),
  field('short_text', 'row_price', { readOnly: true }),
  field('number', 'qty'),
  field('calculation', 'total', { config: { expr: { k: 'call', fn: 'sum', args: [ref('row_price')] }, resultType: 'number', display: 'visible' } }),
], [page('p1', ['menu', 'price', 'amount', 'fee', 'items', 'total'])], [
  rule('fill', cond(ans('menu'), 'is_answered'), [set('price', { k: 'call', fn: 'option_code', args: [ref('menu')] })]),
  rule('pct', cond(ans('amount'), 'is_answered'), [set('fee', { k: 'binary', op: '/', left: { k: 'binary', op: '*', left: ref('amount'), right: n('10') }, right: n('100') })]),
  rule('row_fill', cond(ans('item'), 'is_answered'), [set('row_price', { k: 'call', fn: 'option_code', args: [ref('item')] })]),
]);

const submit = (raw: Record<string, AnswerValue>) => {
  const version = versionOf(def());
  return checkAnswers(version, 'v1', withoutServerOwned(version.definition, raw), LOCALE, NOW);
};

describe('a forged value for a field a rule sets', () => {
  it('is replaced by the value the server works out when the rule writes it (fill from option, percent)', () => {
    const checked = submit({ menu: a.single('burger'), price: a.text('1'), amount: a.number('1000'), fee: a.number('1') });
    expect(checked.errors).toEqual([]);
    expect(checked.values[bid('price')]).toEqual(a.text('467'));
    expect(checked.values[bid('fee')]).toEqual(a.number('100'));
  });

  it('is dropped when the rule does not write it: the field stays empty, it does not keep the respondent\'s word', () => {
    const checked = submit({ price: a.text('1'), fee: a.number('5') });
    expect(checked.errors).toEqual([]);
    expect(checked.values[bid('price')]).toBeUndefined();
    expect(checked.values[bid('fee')]).toBeUndefined();
  });

  it('is dropped from the rows of a repeating group, so a row formula reads the option code and not the forged copy', () => {
    const rows = a.group([{ rowId: 'r1', values: { [bid('item')]: a.single('tea'), [bid('row_price')]: a.text('99999'), [bid('qty')]: a.number('1') } }]);
    const checked = submit({ items: rows });
    const stored = checked.values[bid('items')] as { value: { rows: Array<{ values: Record<string, unknown> }> } };
    expect(stored.value.rows[0]?.values).not.toHaveProperty('row_price');
    expect(checked.values[bid('total')]).toEqual({ type: 'calculation', value: { t: 'number', v: '20' } });
  });

  it('keeps the answer of a field no enabled rule sets', () => {
    const version = versionOf(def());
    const off = { ...version.definition, logic: { ...version.definition.logic, rules: version.definition.logic.rules.map((r) => (r.id === id('pct') ? { ...r, enabled: false } : r)) } };
    expect(withoutServerOwned(off, { fee: a.number('5') })).toEqual({ fee: a.number('5') });
    expect(withoutServerOwned(version.definition, { fee: a.number('5') })).toEqual({});
  });
});
