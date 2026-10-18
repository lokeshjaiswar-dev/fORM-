import type { LogicOperator } from '@form/schema';

type Operators = readonly LogicOperator[];

export const PRESENCE_OPS = ['is_answered', 'is_not_answered'] as const satisfies Operators;
export const TEXT_OPS = [
  ...PRESENCE_OPS, 'eq', 'neq', 'contains', 'not_contains', 'starts_with', 'not_starts_with', 'ends_with', 'not_ends_with',
] as const satisfies Operators;
export const NUMBER_OPS = [...PRESENCE_OPS, 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'] as const satisfies Operators;
/** Dates and times use the before/after aliases; logic compiles them to lt/gt/lte/gte. */
export const TEMPORAL_OPS = [...PRESENCE_OPS, 'eq', 'neq', 'before', 'after', 'on_or_before', 'on_or_after', 'between'] as const satisfies Operators;
export const CHOICE_OPS = [...PRESENCE_OPS, 'eq', 'neq', 'includes_any', 'includes_none'] as const satisfies Operators;
export const CHOICES_OPS = [
  ...PRESENCE_OPS, 'eq', 'neq', 'includes_any', 'includes_all', 'includes_none', 'count_eq', 'count_gte', 'count_lte',
] as const satisfies Operators;
export const FILE_OPS = [...PRESENCE_OPS, 'count_eq', 'count_gte', 'count_lte'] as const satisfies Operators;
