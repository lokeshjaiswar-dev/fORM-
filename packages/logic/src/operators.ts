import { NUMBER_OPS, PRESENCE_OPS, TEMPORAL_OPS, TEXT_OPS } from '@form/registry';
import type { ComparableKind, LogicOperator, ScalarValue } from '@form/schema';
import { compareDecimal } from './decimal.ts';
import { comparable } from './text.ts';

/*
 * Condition operators (schema §3.2). Every function here is total: a value of the wrong shape, an
 * invalid decimal or a missing operand makes the comparison false, never an exception.
 */

/** Operators of operands that are not answers (meta values, literals, expressions); answers use the registry's sets. */
export const OPERAND_OPERATORS: Partial<Record<ComparableKind, readonly LogicOperator[]>> = {
  text: TEXT_OPS,
  number: NUMBER_OPS,
  date: TEMPORAL_OPS,
  time: TEMPORAL_OPS,
  boolean: [...PRESENCE_OPS, 'eq', 'neq', 'is_true', 'is_false'],
};

/** The date and time aliases compile to the ordering operators. */
export const ALIASES: Partial<Record<LogicOperator, LogicOperator>> = { before: 'lt', after: 'gt', on_or_before: 'lte', on_or_after: 'gte' };
export const baseOperator = (op: LogicOperator): LogicOperator => ALIASES[op] ?? op;

/** Operators that take no right operand. */
export const UNARY: ReadonlySet<LogicOperator> = new Set<LogicOperator>(['is_answered', 'is_not_answered', 'is_true', 'is_false']);

export const NULL: ScalarValue = { t: 'null' };
export const isNull = (v: ScalarValue): boolean => v.t === 'null';

/** Option ids of a choice value or an option list; null for anything else. */
function optionSet(v: ScalarValue): Set<string> | null {
  if (v.t === 'option') return new Set([v.v]);
  if (v.t === 'list' && v.of === 'option') return new Set(v.items.flatMap((item) => (item.t === 'option' ? [item.v] : [])));
  return null;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

/** Sign of a − b for two ordered scalars of one kind; null when they cannot be ordered. */
export function order(a: ScalarValue, b: ScalarValue): -1 | 0 | 1 | null {
  if (a.t === 'number' && b.t === 'number') return compareDecimal(a.v, b.v);
  if (a.t === 'money' && b.t === 'money') return a.currency === b.currency ? compareDecimal(a.v, b.v) : null;
  if ((a.t === 'date' && b.t === 'date') || (a.t === 'time' && b.t === 'time')) return a.v === b.v ? 0 : a.v < b.v ? -1 : 1;
  if (a.t === 'datetime' && b.t === 'datetime') return a.tz === b.tz ? (a.v === b.v ? 0 : a.v < b.v ? -1 : 1) : null;
  return null;
}

/** Null-safe equality of two scalars; text compares in its comparison form. */
export function equal(a: ScalarValue, b: ScalarValue, caseSensitive: boolean): boolean {
  if (isNull(a) || isNull(b)) return isNull(a) && isNull(b);
  const left = optionSet(a);
  const right = optionSet(b);
  if (left && right) return sameSet(left, right);
  if (a.t === 'text' && b.t === 'text') return comparable(a.v, caseSensitive) === comparable(b.v, caseSensitive);
  if (a.t === 'boolean' && b.t === 'boolean') return a.v === b.v;
  return order(a, b) === 0;
}

function textTest(a: ScalarValue, b: ScalarValue, caseSensitive: boolean, test: (x: string, y: string) => boolean): boolean {
  if (a.t !== 'text' || b.t !== 'text') return false;
  return test(comparable(a.v, caseSensitive), comparable(b.v, caseSensitive));
}

const count = (v: ScalarValue): number | null => (v.t === 'list' ? v.items.length : isNull(v) ? 0 : null);

function countTest(a: ScalarValue, b: ScalarValue, test: (sign: number) => boolean): boolean {
  const n = count(a);
  if (n === null || b.t !== 'number') return false;
  const sign = compareDecimal(String(n), b.v);
  return sign !== null && test(sign);
}

function ordered(a: ScalarValue, b: ScalarValue, test: (sign: number) => boolean): boolean {
  const sign = order(a, b);
  return sign !== null && test(sign);
}

export interface Comparison {
  op: LogicOperator;
  left: ScalarValue;
  right: ScalarValue;
  right2: ScalarValue;
  caseSensitive: boolean;
  /** For is_answered: the answer is present and not empty (registry isEmpty), on top of being visible. */
  answered: boolean;
}

/**
 * One condition leaf. `null` is false, except through the null-safe `eq` / `neq`; the negated text and
 * set operators negate their positive form, so they are true on `null` (schema §3.1, as in v1).
 */
export function compare({ op, left, right, right2, caseSensitive, answered }: Comparison): boolean {
  switch (baseOperator(op)) {
    case 'is_answered':
      return answered;
    case 'is_not_answered':
      return !answered;
    case 'eq':
      return equal(left, right, caseSensitive);
    case 'neq':
      return !equal(left, right, caseSensitive);
    case 'contains':
      return textTest(left, right, caseSensitive, (x, y) => x.includes(y));
    case 'not_contains':
      return !textTest(left, right, caseSensitive, (x, y) => x.includes(y));
    case 'starts_with':
      return textTest(left, right, caseSensitive, (x, y) => x.startsWith(y));
    case 'not_starts_with':
      return !textTest(left, right, caseSensitive, (x, y) => x.startsWith(y));
    case 'ends_with':
      return textTest(left, right, caseSensitive, (x, y) => x.endsWith(y));
    case 'not_ends_with':
      return !textTest(left, right, caseSensitive, (x, y) => x.endsWith(y));
    case 'gt':
      return ordered(left, right, (s) => s > 0);
    case 'gte':
      return ordered(left, right, (s) => s >= 0);
    case 'lt':
      return ordered(left, right, (s) => s < 0);
    case 'lte':
      return ordered(left, right, (s) => s <= 0);
    case 'between':
      return ordered(left, right, (s) => s >= 0) && ordered(left, right2, (s) => s <= 0);
    case 'includes_any':
    case 'includes_all':
    case 'includes_none': {
      const have = optionSet(left) ?? new Set<string>();
      const want = optionSet(right);
      if (!want) return false;
      const any = [...want].some((id) => have.has(id));
      if (op === 'includes_any') return any;
      if (op === 'includes_none') return !any;
      return isNull(left) ? false : [...want].every((id) => have.has(id));
    }
    case 'count_eq':
      return countTest(left, right, (s) => s === 0);
    case 'count_gte':
      return countTest(left, right, (s) => s >= 0);
    case 'count_lte':
      return countTest(left, right, (s) => s <= 0);
    case 'is_true':
      return left.t === 'boolean' && left.v;
    case 'is_false':
      return left.t === 'boolean' && !left.v;
    default:
      return false;
  }
}
