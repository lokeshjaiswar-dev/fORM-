import type { BlockId, DecimalString, Expr } from '@form/schema';

/*
 * Author-facing formulas for calculation fields: field keys, numbers and + − × ÷ with parentheses.
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
      const id = fields.get(key[0]);
      if (!id) return fail(`Unknown field ‘${key[0]}’`);
      i += key[0].length;
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

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

export function formatFormula(expr: Expr, keys: ReadonlyMap<BlockId, string>): string {
  const go = (e: Expr, parent: number): string => {
    if (e.k === 'lit' && e.value.type === 'number') return e.value.value;
    if (e.k === 'ref' && e.ref.kind === 'answer') return keys.get(e.ref.blockId) ?? '';
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
