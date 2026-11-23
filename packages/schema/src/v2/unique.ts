import type { UniqueConstraint } from './envelope.ts';
import type { BlockId } from './ids.ts';

/** Shown when a field's unique message is blank. Matches system:validation.not_unique. */
export const NOT_UNIQUE_MESSAGE = 'This value has already been used.';

export interface UniqueFieldError {
  blockId: BlockId;
  code: 'not_unique';
  message: string;
}

/** The string a unique constraint compares. Empty after normalization is not a duplicate. */
export function uniqueComparable(normalize: UniqueConstraint['normalize'], answer: unknown): string | null {
  if (normalize === 'e164') {
    const phone = nestedString(answer, 'e164');
    return phone ? phone : null;
  }
  const text = answerText(answer);
  if (text === null) return null;
  if (normalize === 'exact') return text.length ? text : null;
  if (normalize === 'digits') {
    const digits = text.replace(/\D/g, '');
    return digits.length ? digits : null;
  }
  const folded = text.trim().replace(/\s+/g, ' ').toLowerCase();
  return folded.length ? folded : null;
}

/**
 * Fields whose `unique` value already appears in `previous` answers for the same block.
 * `blocks` is a form definition's block map (draft or published).
 */
export function uniqueFieldErrors(
  blocks: object,
  answers: Readonly<Record<string, unknown>>,
  previous: ReadonlyArray<Readonly<Record<string, unknown>>>,
): UniqueFieldError[] {
  const errors: UniqueFieldError[] = [];
  for (const [id, block] of Object.entries(blocks)) {
    const unique = (block as { unique?: UniqueConstraint } | null | undefined)?.unique;
    if (!unique) continue;
    const next = uniqueComparable(unique.normalize, answers[id]);
    if (next === null) continue;
    const taken = previous.some((row) => uniqueComparable(unique.normalize, row[id]) === next);
    if (!taken) continue;
    errors.push({ blockId: id as BlockId, code: 'not_unique', message: unique.message?.trim() || NOT_UNIQUE_MESSAGE });
  }
  return errors;
}

function answerText(answer: unknown): string | null {
  const value = unwrap(answer);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const address = nestedString(value, 'address');
  return address;
}

function unwrap(answer: unknown): unknown {
  if (typeof answer === 'object' && answer !== null && 'value' in answer) return (answer as { value: unknown }).value;
  return answer;
}

function nestedString(answer: unknown, key: string): string | null {
  const value = unwrap(answer);
  if (typeof value !== 'object' || value === null || !(key in value)) return null;
  const inner = (value as Record<string, unknown>)[key];
  return typeof inner === 'string' ? inner : null;
}
