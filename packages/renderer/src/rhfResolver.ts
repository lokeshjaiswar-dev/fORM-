import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form';
import type { FieldError, RuntimeFormVersion } from '@form/schema';
import { loadRegexEngine, needsRegexEngine, validateAnswers, type RawAnswers, type ValidateOptions, type ValidationScope } from '@form/validation/lazy';
import type { EvalSession } from './eval/session.ts';

/** The resolver, the scope its next run validates, and what the last run found (form-level errors have no block). */
export interface Validation {
  resolver: Resolver<FieldValues>;
  /** Sets the scope for the next validation: the page for Next, the whole path for Submit. */
  scope(scope: ValidationScope): void;
  errors(): FieldError[];
}

/**
 * react-hook-form resolver over `@form/validation` (FND-05): the answers are evaluated first, then validated in the
 * current scope, so only visible, enabled blocks in scope can fail (B1, B2). The server runs the same validation.
 * A form that matches text against a pattern, preset or mask waits for re2js, which loads on first use (BL-129).
 */
export function rhfResolver(version: RuntimeFormVersion, session: EvalSession, options: () => Omit<ValidateOptions, 'scope'>): Validation {
  let scope: ValidationScope = 'submit';
  let last: FieldError[] = [];
  const regex = needsRegexEngine(version.definition);
  const resolver: Resolver<FieldValues> = async (values) => {
    if (regex) await loadRegexEngine();
    const raw = values as RawAnswers;
    const { state } = session.evaluate(raw);
    last = validateAnswers(version, state, raw, { ...options(), scope });
    const byBlock: Record<string, { type: string; message: string }> = {};
    for (const error of last) {
      if (error.blockId !== undefined && !byBlock[error.blockId]) byBlock[error.blockId] = { type: error.code, message: error.message };
    }
    return Object.keys(byBlock).length ? { values: {}, errors: byBlock as unknown as FieldErrors<FieldValues> } : { values, errors: {} };
  };
  return {
    resolver,
    scope: (next) => {
      scope = next;
      last = [];
    },
    errors: () => last,
  };
}
