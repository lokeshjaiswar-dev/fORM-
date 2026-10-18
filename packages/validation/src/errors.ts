import { LONG_TEXT_MAX, SHORT_TEXT_MAX, rankCount } from '@form/registry';
import { VALIDATION_ERROR_CODES } from '@form/schema';
import type { FieldBlock, ValidationErrorCode, ValueFieldType } from '@form/schema';
import type { MessageFormatter } from './messages.ts';

/*
 * Answer-schema issues → ValidationErrorCode (fixes B14: no "expected number, received NaN"). Registry
 * checks carry their code in `params.code`; the twin's own issues are mapped by type and issue kind.
 */

export interface Issue {
  code: ValidationErrorCode;
  path: ReadonlyArray<string | number>;
  /** Bound from the twin (`too_small` / `too_big`), used when the block config has none. */
  limit?: number;
}

const CODES: ReadonlySet<string> = new Set(VALIDATION_ERROR_CODES);
export const isValidationCode = (v: unknown): v is ValidationErrorCode => typeof v === 'string' && CODES.has(v);

/** The code for a value of the wrong shape or format, per type. */
const FORMAT: Partial<Record<ValueFieldType, ValidationErrorCode>> = {
  email: 'invalid_email',
  phone: 'invalid_phone',
  url: 'invalid_url',
  number: 'not_a_number',
  single_choice: 'not_in_options',
  multi_choice: 'not_in_options',
  ranking: 'not_in_options',
  date: 'invalid_date',
  datetime: 'invalid_date',
  time: 'invalid_time',
  rating: 'not_integer',
  linear_scale: 'not_integer',
  nps: 'not_integer',
};

const TOO_MANY: Partial<Record<ValueFieldType, ValidationErrorCode>> = {
  file_upload: 'too_many_files',
  ranking: 'too_many_selected',
  multi_choice: 'too_many_selected',
  repeating_group: 'too_many_rows',
};
const TOO_FEW: Partial<Record<ValueFieldType, ValidationErrorCode>> = {
  file_upload: 'too_few_files',
  ranking: 'too_few_selected',
  multi_choice: 'too_few_selected',
  repeating_group: 'too_few_rows',
};

interface RawIssue { code?: unknown; path?: unknown; params?: unknown; origin?: unknown; minimum?: unknown; maximum?: unknown }

const pathOf = (issue: RawIssue): Array<string | number> =>
  Array.isArray(issue.path) ? issue.path.filter((p): p is string | number => typeof p === 'string' || typeof p === 'number') : [];

const bound = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : undefined);

/** The code a registry check put on its issue (`params.code`), if any. */
function registryCode(issue: RawIssue): ValidationErrorCode | undefined {
  const code = (issue.params as { code?: unknown } | undefined)?.code;
  return issue.code === 'custom' && isValidationCode(code) ? code : undefined;
}

function codeOf(type: ValueFieldType, issue: RawIssue): ValidationErrorCode {
  const checked = registryCode(issue);
  if (checked) return checked;
  const format = FORMAT[type] ?? 'invalid_format';
  if (issue.code === 'too_big') {
    if (issue.origin === 'string') return 'too_long';
    if (issue.origin === 'number') return 'above_max';
    if (issue.origin === 'array' && pathOf(issue).length === 0) return TOO_MANY[type] ?? format;
  }
  if (issue.code === 'too_small') {
    if (issue.origin === 'string') return pathOf(issue).length === 0 ? 'required' : 'too_short';
    if (issue.origin === 'number') return 'below_min';
    if (issue.origin === 'array' && pathOf(issue).length === 0) return TOO_FEW[type] ?? 'required';
  }
  return format;
}

/** The issues of a failed `answerSchema` parse, in report order. */
export function issuesOf(type: ValueFieldType, error: unknown): Issue[] {
  const raw = (error as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(raw) || raw.length === 0) return [{ code: FORMAT[type] ?? 'invalid_format', path: [] }];
  return raw.map((issue: RawIssue): Issue => {
    const code = codeOf(type, issue);
    const limit = bound(issue.code === 'too_big' ? issue.maximum : issue.code === 'too_small' ? issue.minimum : undefined);
    return limit === undefined ? { code, path: pathOf(issue) } : { code, path: pathOf(issue), limit };
  });
}

/** True when every issue comes from a registry check, so the value itself has the stored shape. */
export const wellShaped = (error: unknown): boolean => {
  const raw = (error as { issues?: unknown } | null)?.issues;
  return Array.isArray(raw) && raw.every((issue: RawIssue) => registryCode(issue) !== undefined);
};

const MIB = 1024 * 1024;
const KIB = 1024;

function bytes(n: number, fmt: MessageFormatter): string {
  if (n >= MIB && n % MIB === 0) return `${fmt.number(n / MIB)} MB`;
  if (n >= KIB && n % KIB === 0) return `${fmt.number(n / KIB)} KB`;
  return `${fmt.number(n)} bytes`;
}

type Values = Record<string, string | number>;

const textMax = (block: FieldBlock, path: ReadonlyArray<string | number>): number | undefined => {
  switch (block.type) {
    case 'short_text':
      return block.config.maxLength ?? SHORT_TEXT_MAX;
    case 'long_text':
      return block.config.limit?.unit === 'characters' ? (block.config.limit.max ?? LONG_TEXT_MAX) : LONG_TEXT_MAX;
    case 'single_choice':
    case 'multi_choice':
      return path[0] === 'other' ? block.config.other?.maxLength : undefined;
    default:
      return undefined;
  }
};

const textMin = (block: FieldBlock): number | undefined =>
  block.type === 'short_text' ? block.config.minLength : block.type === 'long_text' ? block.config.limit?.min : undefined;

/** Lowest and highest accepted values of a numeric block, as message strings. */
function numberBounds(block: FieldBlock, fmt: MessageFormatter): { min?: string; max?: string } {
  switch (block.type) {
    case 'number': {
      const { min, max, allowNegative } = block.config;
      const low = min ?? (allowNegative === false ? '0' : undefined);
      return { ...(low === undefined ? {} : { min: fmt.number(low) }), ...(max === undefined ? {} : { max: fmt.number(max) }) };
    }
    case 'rating':
      return { min: fmt.number(1), max: fmt.number(block.config.max) };
    case 'linear_scale':
      return { min: fmt.number(block.config.min), max: fmt.number(block.config.max) };
    case 'nps':
      return { min: fmt.number(0), max: fmt.number(10) };
    default:
      return {};
  }
}

/**
 * The arguments the en-IN message for `issue.code` needs, from the block's config (the twin's bound as a
 * fallback). Counts are numbers (plural rules); values and sizes are formatted strings.
 */
export function valuesFor(block: FieldBlock, issue: Issue, fmt: MessageFormatter, value?: unknown): Values {
  const { code, path, limit } = issue;
  switch (code) {
    case 'too_short':
      return { min: textMin(block) ?? limit ?? 1 };
    case 'too_long':
      return { max: textMax(block, path) ?? limit ?? 0 };
    case 'too_few_words':
      return { min: block.type === 'long_text' ? (block.config.limit?.min ?? 0) : 0 };
    case 'too_many_words':
      return { max: block.type === 'long_text' ? (block.config.limit?.max ?? 0) : 0 };
    case 'below_min': {
      const { min } = numberBounds(block, fmt);
      return { min: min ?? (limit === undefined ? '' : fmt.number(limit)) };
    }
    case 'above_max': {
      const { max } = numberBounds(block, fmt);
      return { max: max ?? (limit === undefined ? '' : fmt.number(limit)) };
    }
    case 'step':
      return { step: block.type === 'number' && block.config.step !== undefined ? fmt.number(block.config.step) : '' };
    case 'too_few_selected':
      if (block.type === 'ranking') return { min: rankCount(block.config) };
      return { min: block.type === 'multi_choice' ? (block.config.minSelected ?? 1) : (limit ?? 1) };
    case 'too_many_selected':
      if (block.type === 'ranking') return { max: rankCount(block.config) };
      if (block.type === 'multi_choice') return { max: exclusiveHit(block, value) ? 1 : (block.config.maxSelected ?? 1) };
      return { max: limit ?? 1 };
    case 'too_many_files':
      return { max: block.type === 'file_upload' ? block.config.maxFiles : (limit ?? 0) };
    case 'too_few_files':
      return { min: block.type === 'file_upload' ? (block.config.minFiles ?? 1) : (limit ?? 1) };
    case 'file_too_large':
      return { max: block.type === 'file_upload' ? bytes(block.config.maxFileBytes, fmt) : '' };
    case 'file_too_small':
      return { min: block.type === 'file_upload' ? bytes(block.config.minFileBytes ?? 0, fmt) : '' };
    case 'file_type_not_allowed': {
      if (block.type !== 'file_upload') return { types: '' };
      const { extensions, mimeTypes } = block.config.accept;
      return { types: (extensions.length ? extensions.map((e) => e.replace(/^\./, '')) : mimeTypes).join(', ') };
    }
    case 'too_few_rows':
      return { min: block.type === 'repeating_group' ? block.config.minRows : (limit ?? 1) };
    case 'too_many_rows':
      return { max: block.type === 'repeating_group' ? block.config.maxRows : (limit ?? 0) };
    default:
      return {};
  }
}

/** A multi-choice "too many" caused by an exclusive option ("None of the above") picked with others, not by `maxSelected`. */
function exclusiveHit(block: Extract<FieldBlock, { type: 'multi_choice' }>, value: unknown): boolean {
  const v = value as { optionIds?: unknown; other?: unknown } | undefined;
  const ids = Array.isArray(v?.optionIds) ? (v.optionIds as unknown[]) : [];
  const count = ids.length + (v?.other !== undefined ? 1 : 0);
  const { exclusiveOptionIds, maxSelected } = block.config;
  return count > 1 && ids.some((id) => exclusiveOptionIds?.includes(id as never)) && (maxSelected === undefined || count <= maxSelected);
}
