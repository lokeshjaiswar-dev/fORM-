import type { BlockId, CurrencyCode, DecimalString, IsoDate, IsoLocalDateTime, IsoTime, MinorUnits, OptionId, TimeZone } from './ids.ts';
import type { ConditionGroup, Literal } from './logic.ts';
import type { ValueRef } from './rich-text.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §10  EXPRESSION AST (LOG-14..19) — typed, total, deterministic, never eval'd
 * ═════════════════════════════════════════════════════════════════════════ */

export type ScalarType = 'number' | 'money' | 'text' | 'boolean' | 'date' | 'time' | 'datetime' | 'duration' | 'option';
export type ExprType = ScalarType | { list: ScalarType } | 'null';

/** Runtime values inside the evaluator. */
export type ScalarValue =
  | { t: 'number'; v: DecimalString }
  | { t: 'money'; v: MinorUnits; currency: CurrencyCode }
  | { t: 'text'; v: string }
  | { t: 'boolean'; v: boolean }
  | { t: 'date'; v: IsoDate }
  | { t: 'time'; v: IsoTime }
  | { t: 'datetime'; v: IsoLocalDateTime; tz: TimeZone }
  | { t: 'duration'; v: { days: number; minutes: number } }
  | { t: 'option'; blockId: BlockId; v: OptionId }
  | { t: 'list'; of: ScalarType; items: ScalarValue[] }
  | { t: 'null' };

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%' | '^'
  | '&'                                   // text concatenation
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | 'and' | 'or';

export const EXPR_FUNCTIONS = [
  // math
  'abs', 'ceil', 'floor', 'round', 'trunc', 'sqrt', 'pow', 'exp', 'ln', 'log10', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'pi', 'e',
  // aggregates
  'min', 'max', 'sum', 'avg', 'avg_no_zero', 'count', 'count_answered', 'nth',
  // null / flow
  'coalesce', 'is_empty',
  // text
  'concat', 'upper', 'lower', 'trim', 'len', 'left', 'right', 'mid', 'replace', 'contains', 'join', 'comma_separate',
  'format_number', 'to_text', 'to_number',
  // choices
  'option_label', 'option_code', 'option_score', 'selected_count', 'score_sum', 'quiz_score', 'quiz_correct_count', 'nps_category',
  // dates (form time zone; never host clock)
  'today', 'now', 'date_add', 'date_diff', 'age', 'working_days', 'year', 'month', 'day', 'weekday', 'make_date', 'format_date',
  // money
  'money', 'to_minor', 'from_minor', 'money_round', 'gst_split',
  // repeating groups
  'row_count',
] as const;
export type ExprFunction = (typeof EXPR_FUNCTIONS)[number];

export type Expr =
  | { k: 'lit'; value: Literal }
  | { k: 'ref'; ref: ValueRef }
  | { k: 'unary'; op: 'neg' | 'not'; arg: Expr }
  | { k: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { k: 'if'; cond: Expr | ConditionGroup; then: Expr; else: Expr }
  | { k: 'call'; fn: ExprFunction; args: Expr[] }
  | { k: 'list'; items: Expr[] };

export interface ExprFunctionSignature {
  params: Array<ExprType | 'any' | 'block_ref'>;
  rest?: ExprType | 'any';
  returns: ExprType | 'same_as_first';
  /** false for now/today: the evaluator substitutes the frozen meta clock. */
  pure: boolean;
}
export type ExprFunctionTable = Readonly<Record<ExprFunction, ExprFunctionSignature>>;
