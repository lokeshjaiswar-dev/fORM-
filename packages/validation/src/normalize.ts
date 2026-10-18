import { valueDefinition } from '@form/registry';
import { VALUE_FIELD_TYPES } from '@form/schema';
import type { AnswerValue, Answers, ValueFieldType } from '@form/schema';

/*
 * I9: unanswered === key absent; never '', null or [] in Answers. Controls produce empty strings, empty
 * lists and blank sub-parts; `normalizeAnswers` drops them so a value that reaches validation or storage is
 * either absent or an answer. It never trims, case-folds or reorders what the respondent typed.
 */

/** Raw answers from controls, possibly blank. */
export type RawAnswers = Readonly<Record<string, AnswerValue | null | undefined>>;

const VALUE_TYPES: ReadonlySet<string> = new Set(VALUE_FIELD_TYPES);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const blank = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** `record` without the listed optional keys that are blank; the same object when none is. */
function without(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const drop = keys.filter((key) => Object.hasOwn(record, key) && blank(record[key]));
  if (drop.length === 0) return record;
  const out = { ...record };
  for (const key of drop) delete out[key];
  return out;
}

/** Drops blank entries of a record (name parts, address parts, matrix rows and cells); the same object when none is. */
function compact(record: unknown, keep: (v: unknown) => boolean = (v) => !blank(v)): unknown {
  if (!isRecord(record)) return record;
  const entries = Object.entries(record);
  const kept = entries.filter(([, v]) => keep(v));
  return kept.length === entries.length ? record : Object.fromEntries(kept);
}

function pruneMatrix(value: Record<string, unknown>): unknown {
  const rows = value['rows'];
  if (!isRecord(rows)) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [row, cells] of Object.entries(rows)) {
    const kept = value['mode'] === 'grid' ? compact(cells) : cells;
    if (kept !== cells) changed = true;
    if (blank(kept) || (isRecord(kept) && Object.keys(kept).length === 0)) changed = true;
    else next[row] = kept;
  }
  return changed ? { ...value, rows: next } : value;
}

function pruneRows(value: Record<string, unknown>): unknown {
  const rows = value['rows'];
  if (!Array.isArray(rows)) return value;
  let changed = false;
  const next = rows.map((row: unknown) => {
    if (!isRecord(row) || !isRecord(row['values'])) return row;
    const values = normalizeAnswers(row['values'] as RawAnswers);
    const same = Object.keys(values).length === Object.keys(row['values']).length
      && Object.entries(values).every(([id, v]) => (row['values'] as Record<string, unknown>)[id] === v);
    if (same) return row;
    changed = true;
    return { ...row, values };
  });
  return changed ? { ...value, rows: next } : value;
}

/** The value with blank optional parts removed (the same object when nothing is blank). */
function pruned(type: string, value: Record<string, unknown>): unknown {
  switch (type) {
    case 'email':
      return without(value, ['otpProof']);
    case 'single_choice':
    case 'multi_choice':
      return without(value, ['other']);
    case 'time':
      return without(value, ['end']);
    case 'full_name':
    case 'address':
      return compact(value);
    case 'matrix':
      return pruneMatrix(value);
    case 'payment':
      return without(value, ['items', 'couponCode']);
    case 'repeating_group':
      return pruneRows(value);
    default:
      return value;
  }
}

/** Removes blank optional parts so the answer either is empty or has the stored shape. */
function prune(answer: AnswerValue): AnswerValue {
  const value: unknown = answer.value;
  if (!isRecord(value)) return answer;
  const next = pruned(answer.type, value);
  return next === value ? answer : ({ ...answer, value: next } as AnswerValue);
}

/** True when `answer` is unanswered for its type (I9), judged by the registry's `isEmpty` after pruning. */
export function isUnanswered(answer: AnswerValue): boolean {
  if (blank(answer.value)) return true;
  if (!VALUE_TYPES.has(answer.type)) return false;
  try {
    return (valueDefinition(answer.type as ValueFieldType).isEmpty as (value: unknown) => boolean)(answer.value);
  } catch {
    /* A wrong-shaped value is not empty: validation reports it. */
    return false;
  }
}

/**
 * Normalises one raw answer: blank optional parts removed; undefined when the result is unanswered. Values
 * that are not tagged answers are kept as they are, for validation to report.
 */
export function normalizeAnswer(answer: AnswerValue | null | undefined): AnswerValue | undefined {
  if (answer === null || answer === undefined) return undefined;
  if (!isRecord(answer) || typeof answer.type !== 'string') return answer;
  const pruned = prune(answer);
  return isUnanswered(pruned) ? undefined : pruned;
}

/** I9 over a whole answer map: blank answers become absent keys. The input is not modified. */
export function normalizeAnswers(raw: RawAnswers): Answers {
  const out: Record<string, AnswerValue> = {};
  for (const [id, answer] of Object.entries(raw)) {
    const normalized = normalizeAnswer(answer);
    if (normalized !== undefined) out[id] = normalized;
  }
  return out as Answers;
}
