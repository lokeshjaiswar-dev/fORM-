import type { BlockId, DecimalString, Expr } from '@form/schema';

/*
 * Author-facing formulas for calculation fields: field keys, numbers, sum(field) and + − × ÷ with parentheses.
 * The AST is the schema Expr; this is only a view of that subset.
 */

const KEY = /^[a-z][a-z0-9_]{0,63}/;
const NUMBER = /^(0|[1-9]\d*)(?:\.\d{1,10})?/;

export type FormulaResult = { ok: true; expr: Expr } | { ok: false; error: string };

export function parseFormula(text: string, fields: ReadonlyMap<string, BlockId>): FormulaResult {
  const src = text.trim();
  if (!src) return { ok: true, expr: { k: 'lit', value: { type: 'number', value: '0' as DecimalString } } };
  let i = 0;
  const peek = () => src[i] ?? '';
  const skip = () => {
    while (src[i] === ' ') i += 1;
  };
  const fail = (error: string): FormulaResult => ({ ok: false, error });

  const primary = (): FormulaResult => {
    skip();
    if (peek() === '(') {
      i += 1;
      const inner = expr();
      if (!inner.ok) return inner;
      skip();
      if (peek() !== ')') return fail('Close the parenthesis');
      i += 1;
      return inner;
    }
    const rest = src.slice(i);
    const num = NUMBER.exec(rest);
    if (num) {
      i += num[0].length;
      return { ok: true, expr: { k: 'lit', value: { type: 'number', value: num[0] as DecimalString } } };
    }
    const key = KEY.exec(rest);
    if (key) {
      i += key[0].length;
      skip();
      if (peek() === '(') {
        if (key[0] !== 'sum') return fail(`Unknown function ‘${key[0]}’`);
        i += 1;
        const arg = expr();
        if (!arg.ok) return arg;
        skip();
        if (peek() !== ')') return fail('Close the parenthesis');
        i += 1;
        return { ok: true, expr: { k: 'call', fn: 'sum', args: [arg.expr] } };
      }
      const id = fields.get(key[0]);
      if (!id) return fail(`Unknown field ‘${key[0]}’`);
      return { ok: true, expr: { k: 'ref', ref: { kind: 'answer', blockId: id } } };
    }
    return fail('Expected a number, a field key or ‘(’');
  };

  const unary = (): FormulaResult => {
    skip();
    if (peek() === '-') {
      i += 1;
      const arg = unary();
      if (!arg.ok) return arg;
      return { ok: true, expr: { k: 'unary', op: 'neg', arg: arg.expr } };
    }
    return primary();
  };

  const term = (): FormulaResult => {
    let left = unary();
    if (!left.ok) return left;
    for (;;) {
      skip();
      const op = peek();
      if (op !== '*' && op !== '/') break;
      i += 1;
      const right = unary();
      if (!right.ok) return right;
      left = { ok: true, expr: { k: 'binary', op, left: left.expr, right: right.expr } };
    }
    return left;
  };

  const expr = (): FormulaResult => {
    let left = term();
    if (!left.ok) return left;
    for (;;) {
      skip();
      const op = peek();
      if (op !== '+' && op !== '-') break;
      i += 1;
      const right = term();
      if (!right.ok) return right;
      left = { ok: true, expr: { k: 'binary', op, left: left.expr, right: right.expr } };
    }
    return left;
  };

  const result = expr();
  if (!result.ok) return result;
  skip();
  if (i < src.length) return fail('Unexpected text after the formula');
  return result;
}

/**
 * Marks references to fields in the same repeating-group row as row-scoped (`row: 'current'`), so a formula inside a
 * list is evaluated once per row. `sameRow` says whether a referenced block sits in the formula's own row group.
 */
export function markRowRefs(expr: Expr, sameRow: (id: BlockId) => boolean): Expr {
  const go = (e: Expr): Expr => {
    switch (e.k) {
      case 'ref':
        return e.ref.kind === 'answer' && sameRow(e.ref.blockId) ? { ...e, ref: { ...e.ref, row: 'current' } } : e;
      case 'unary':
        return { ...e, arg: go(e.arg) };
      case 'call':
        return { ...e, args: e.args.map(go) };
      case 'binary':
        return { ...e, left: go(e.left), right: go(e.right) };
      default:
        return e;
    }
  };
  return go(expr);
}

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

export function formatFormula(expr: Expr, keys: ReadonlyMap<string, string>): string {
  const go = (e: Expr, parent: number): string => {
    if (e.k === 'lit' && e.value.type === 'number') return e.value.value;
    if (e.k === 'ref' && e.ref.kind === 'answer') {
      const key = e.ref.path ? `${e.ref.blockId}|${e.ref.path}` : e.ref.blockId;
      return keys.get(key) ?? '';
    }
    if (e.k === 'call' && e.fn === 'sum' && e.args[0]) return `sum(${go(e.args[0], 0)})`;
    if (e.k === 'unary' && e.op === 'neg') return `-${go(e.arg, 3)}`;
    if (e.k === 'binary' && PREC[e.op] !== undefined) {
      const p = PREC[e.op] ?? 0;
      const rightPrec = e.op === '-' || e.op === '/' ? p + 1 : p;
      const text = `${go(e.left, p)} ${e.op} ${go(e.right, rightPrec)}`;
      return p < parent ? `(${text})` : text;
    }
    return '';
  };
  return go(expr, 0);
}
