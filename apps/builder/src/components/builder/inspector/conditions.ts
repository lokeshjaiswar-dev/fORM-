import { REGISTRY } from '@form/registry';
import {
  IsoDateSchema, IsoTimeSchema,
  type BlockId, type ComparableKind, type Condition, type ConditionId, type DecimalString, type FieldBlock, type IsoDate, type IsoTime,
  type LogicOperator, type Operand, type OptionId,
} from '@form/schema';
import type { labelString } from '@/fields/style';

/** Operators the rule editor offers: the P0 subset, with one right operand. */
const EDITABLE: ReadonlySet<LogicOperator> = new Set<LogicOperator>([
  'is_answered', 'is_not_answered', 'eq', 'neq', 'contains', 'not_contains', 'starts_with', 'not_starts_with', 'ends_with', 'not_ends_with',
  'gt', 'gte', 'lt', 'lte', 'before', 'after', 'on_or_before', 'on_or_after', 'includes_any', 'includes_all', 'includes_none', 'count_eq', 'count_gte', 'count_lte',
]);
export const UNARY: ReadonlySet<LogicOperator> = new Set<LogicOperator>(['is_answered', 'is_not_answered']);
export const COUNT: ReadonlySet<LogicOperator> = new Set<LogicOperator>(['count_eq', 'count_gte', 'count_lte']);

/** The comparable kind of a field's whole answer (registry `paths['']`). */
export const kindOf = (block: FieldBlock): ComparableKind | undefined => (REGISTRY[block.type].paths as Readonly<Record<string, ComparableKind>>)[''];

/** The operators a source field allows (registry `operators`), within what the editor offers. */
export function operatorsFor(block: FieldBlock): LogicOperator[] {
  const kind = kindOf(block);
  const ops = (kind && (REGISTRY[block.type].operators as Partial<Record<ComparableKind, readonly LogicOperator[]>>)[kind]) || [];
  return ops.filter((op) => EDITABLE.has(op));
}

export const choiceOptions = (block: FieldBlock) => ('options' in block.config ? (block.config.options as Array<{ id: OptionId; label: Parameters<typeof labelString>[0] }>) : []);

const choiceOperand = (kind: ComparableKind | undefined, op: LogicOperator) => (kind === 'choice' || kind === 'choices') && !COUNT.has(op);

/** The literal type a binary operator on `kind` compares against; null when the editor has no typed value for it. */
function literalType(kind: ComparableKind | undefined, op: LogicOperator): 'number' | 'date' | 'time' | 'text' | null {
  if (COUNT.has(op) || kind === 'number') return 'number';
  if (kind === 'date' || kind === 'time' || kind === 'text') return kind;
  return null;
}

/** The literal a typed value makes for the source's kind; null when the text is not one. */
export function literal(kind: ComparableKind | undefined, op: LogicOperator, text: string): Operand | null {
  const type = literalType(kind, op);
  if (type === 'number') {
    return /^-?(0|[1-9]\d*)(\.\d{1,10})?$/.test(text) && (!COUNT.has(op) || /^\d+$/.test(text)) ? { kind: 'literal', value: { type: 'number', value: text as DecimalString } } : null;
  }
  if (type === 'date') return IsoDateSchema.safeParse(text).success ? { kind: 'literal', value: { type: 'date', value: text as IsoDate } } : null;
  if (type === 'time') return IsoTimeSchema.safeParse(text).success ? { kind: 'literal', value: { type: 'time', value: text as IsoTime } } : null;
  if (type === 'text') return { kind: 'literal', value: { type: 'text', value: text } };
  return null;
}

/** Whether `right` is an operand `op` on `source` can compile with. */
export function fits(source: FieldBlock, op: LogicOperator, right: Operand | undefined): boolean {
  if (UNARY.has(op)) return right === undefined;
  if (!right) return false;
  const kind = kindOf(source);
  if (choiceOperand(kind, op)) return right.kind === 'options' && right.blockId === source.id && right.optionIds.length > 0;
  return right.kind === 'literal' && right.value.type === literalType(kind, op);
}

/** What a new date or time value starts at: the author's today, and noon. */
export interface Defaults {
  today: IsoDate;
}

/** A right operand that fits `op` on `source`; undefined for a unary operator or when there is none to start from. */
export function initialRight(source: FieldBlock, op: LogicOperator, defaults: Defaults): Operand | undefined {
  if (UNARY.has(op)) return undefined;
  const kind = kindOf(source);
  if (choiceOperand(kind, op)) {
    const first = choiceOptions(source)[0];
    return first ? { kind: 'options', blockId: source.id, optionIds: [first.id] } : undefined;
  }
  switch (literalType(kind, op)) {
    case 'number': return { kind: 'literal', value: { type: 'number', value: (COUNT.has(op) ? '1' : '0') as DecimalString } };
    case 'date': return { kind: 'literal', value: { type: 'date', value: defaults.today } };
    case 'time': return { kind: 'literal', value: { type: 'time', value: '12:00' as IsoTime } };
    case 'text': return { kind: 'literal', value: { type: 'text', value: '' } };
    default: return undefined;
  }
}

/** The operator a new condition starts with: 'is' when the source has it and a value to start from, else the first that compiles. */
export function firstOperator(source: FieldBlock, defaults: Defaults): LogicOperator {
  const ops = operatorsFor(source);
  const ready = ops.filter((op) => fits(source, op, initialRight(source, op, defaults)));
  return ready.includes('eq') ? 'eq' : (ready[0] ?? 'is_answered');
}

export function condition(id: ConditionId, source: FieldBlock, op: LogicOperator, right?: Operand): Condition {
  return { kind: 'condition', id, left: { kind: 'ref', ref: { kind: 'answer', blockId: source.id as BlockId } }, op, ...(right ? { right } : {}) };
}

/** A condition on `source` with `op`: it keeps `right` when that still fits, so switching between like operators keeps the value. */
export function retarget(id: ConditionId, source: FieldBlock, op: LogicOperator, right: Operand | undefined, defaults: Defaults): Condition {
  return condition(id, source, op, fits(source, op, right) ? right : initialRight(source, op, defaults));
}

/** The author's local date, for a new date condition. */
export function localToday(now: Date): IsoDate {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` as IsoDate;
}
