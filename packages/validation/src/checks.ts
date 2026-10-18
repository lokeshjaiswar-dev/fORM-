import { nfc } from '@form/logic';
import type { AnswerValue, DateBound, EvalMeta, EvalState, FieldBlock, IsoDate } from '@form/schema';
import { addDays, ageOn, relativeDate } from './dates.ts';
import type { Issue } from './errors.ts';
import { matchesMask, matchesPreset } from './formats.ts';
import { compilePattern, withinBudget } from './pattern.ts';

/*
 * Checks the registry leaves to validation (registry README): author patterns, presets and masks through
 * re2js, date bounds that need `today` or another answer, holiday calendars, and options that logic hid.
 * They run only on values whose shape the twin accepted.
 */

export interface CheckContext {
  state: EvalState;
  today: IsoDate;
  holidayCalendars: EvalMeta['holidayCalendars'];
}

/**
 * Text is matched in NFC, the form logic compares text in (schema §3.1). Only values within the field's length
 * limit get here (validate.ts reports `too_long` alone). An author pattern or mask whose program size x value
 * length is over `PATTERN_COST_BUDGET` is not run, and the value fails it.
 */
function textIssues(block: Extract<FieldBlock, { type: 'short_text' }>, value: string): Issue[] {
  const { preset, pattern, mask } = block.config;
  const text = nfc(value);
  const issues: Issue[] = [];
  if (preset !== undefined && !matchesPreset(preset, text)) issues.push({ code: 'preset', path: [] });
  if (pattern !== undefined) {
    /* An unusable pattern is ignored here (B12) and refused at publish (VAL-04). */
    const compiled = compilePattern(pattern);
    if (compiled.ok && !(withinBudget(compiled, text) && compiled.test(text))) issues.push({ code: 'pattern', path: [] });
  }
  if (mask !== undefined && matchesMask(mask, text) === false) issues.push({ code: 'mask', path: [] });
  return issues;
}

/** The date a bound stands for, or undefined when it does not apply (a field bound on an unanswered or hidden block). */
function boundDate(bound: DateBound | undefined, ctx: CheckContext): IsoDate | undefined {
  if (!bound || bound.kind === 'absolute') return undefined;
  if (bound.kind === 'relative') return relativeDate(ctx.today, bound);
  const other: AnswerValue | undefined = ctx.state.values[bound.blockId];
  const date = other?.type === 'date' ? other.value : other?.type === 'datetime' ? (other.value.local.slice(0, 10) as IsoDate) : undefined;
  return date === undefined ? undefined : addDays(date, bound.offsetDays ?? 0);
}

function dateIssues(block: Extract<FieldBlock, { type: 'date' }>, value: IsoDate, ctx: CheckContext): Issue[] {
  const limits = block.config.limits;
  if (!limits) return [];
  const issues: Issue[] = [];
  const min = boundDate(limits.min, ctx);
  const max = boundDate(limits.max, ctx);
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) issues.push({ code: 'date_out_of_range', path: [] });
  const holidays = limits.holidayCalendarId === undefined ? undefined : ctx.holidayCalendars?.[limits.holidayCalendarId];
  if (holidays?.includes(value)) issues.push({ code: 'date_not_allowed', path: [] });
  if (limits.age) {
    const age = ageOn(value, ctx.today);
    if ((limits.age.min !== undefined && age < limits.age.min) || (limits.age.max !== undefined && age > limits.age.max)) {
      issues.push({ code: 'age_out_of_range', path: [] });
    }
  }
  return issues;
}

function hiddenOptionIssues(block: FieldBlock, answer: AnswerValue, ctx: CheckContext): Issue[] {
  const hidden = ctx.state.hiddenOptions[block.id];
  if (!hidden?.length) return [];
  if (answer.type === 'single_choice' && answer.value.optionId !== null && hidden.includes(answer.value.optionId)) {
    return [{ code: 'not_in_options', path: ['optionId'] }];
  }
  if (answer.type === 'multi_choice') {
    return answer.value.optionIds.flatMap((id, i): Issue[] => (hidden.includes(id) ? [{ code: 'not_in_options', path: ['optionIds', i] }] : []));
  }
  return [];
}

/** Issues beyond the answer schema for a well-shaped answer of `block`. */
export function extraIssues(block: FieldBlock, answer: AnswerValue, ctx: CheckContext): Issue[] {
  if (block.type === 'short_text' && answer.type === 'short_text') return textIssues(block, answer.value);
  if (block.type === 'date' && answer.type === 'date') return dateIssues(block, answer.value, ctx);
  return hiddenOptionIssues(block, answer, ctx);
}
