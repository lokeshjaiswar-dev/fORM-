import type { SafePattern } from '@form/schema';
import { regexEngine } from './regex.ts';

/*
 * VAL-04: every regex runs through re2js, a pure-JS RE2 port, in the browser and on the server, so `\s`,
 * `\w`, `\b`, `.` and case folding mean the same thing everywhere and matching is linear in the input
 * (no ReDoS). RE2 has no backreferences or lookaround; such a pattern does not compile. Linear is not cheap:
 * when the DFA runs out of states, the NFA keeps up to one thread per instruction alive, so a search costs up to
 * program size x input length steps. Counted repetition makes a short source a large program
 * (`(?:\pL|b){1000}` is 15 characters and 1002 instructions). So a pattern is refused when its program is
 * larger than `PATTERN_MAX_PROGRAM`, and an author pattern or mask is only run when program size x value
 * length is at most `PATTERN_COST_BUDGET` (see checks.ts).
 */

/** Longest author pattern accepted (UTF-16 code units), as the `SafePattern` twin enforces. */
export const PATTERN_MAX_LENGTH = 256;

/**
 * Largest compiled program accepted (re2js `programSize()`). Realistic patterns stay far below it: an
 * RFC-style email pattern is 259, presets are under 50, a 64-slot mask is 68.
 */
export const PATTERN_MAX_PROGRAM = 1000;

/**
 * Most NFA steps (program size x value length in UTF-16 code units) one author pattern or mask may take.
 * Calibrated on the worst shapes (`(?:[\pL\pN]|b){990}$`, `[\pL\pN]{990}$`): about 0.03 us per step in
 * Node on a developer machine and up to about 0.6 us on a slow one, so one check stays under about 0.15 s.
 * A 1000-instruction program runs on values of up to 250 code units, the email pattern above on 965.
 */
export const PATTERN_COST_BUDGET = 250_000;

export type CompiledPattern =
  | { ok: true; size: number; test(value: string): boolean }
  | { ok: false; reason: 'too_long' | 'too_complex' | 'syntax'; message: string };

/** True when searching `value` with `compiled` stays within `PATTERN_COST_BUDGET`. */
export const withinBudget = (compiled: { size: number }, value: string): boolean => compiled.size * value.length <= PATTERN_COST_BUDGET;

const CACHE_LIMIT = 512;
const cache = new Map<string, CompiledPattern>();

function compile(source: string, flags: SafePattern['flags'], capped: boolean): CompiledPattern {
  if (capped && source.length > PATTERN_MAX_LENGTH) {
    return { ok: false, reason: 'too_long', message: `the pattern is longer than ${PATTERN_MAX_LENGTH} characters` };
  }
  const re2 = regexEngine();
  try {
    const re = re2.compile(source, flags === 'i' ? re2.CASE_INSENSITIVE : 0);
    const size = re.programSize();
    if (size > PATTERN_MAX_PROGRAM) {
      return {
        ok: false,
        reason: 'too_complex',
        message: `the pattern is too complex (${size} instructions, at most ${PATTERN_MAX_PROGRAM}); use + or * instead of large {n} counts`,
      };
    }
    return { ok: true, size, test: (value) => re.test(value) };
  } catch (error) {
    return { ok: false, reason: 'syntax', message: error instanceof Error ? error.message : String(error) };
  }
}

function cached(source: string, flags: SafePattern['flags'], capped: boolean): CompiledPattern {
  const key = `${capped ? 'a' : 'b'}${flags ?? ''}/${source}`;
  let compiled = cache.get(key);
  if (!compiled) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    compiled = compile(source, flags, capped);
    cache.set(key, compiled);
  }
  return compiled;
}

/**
 * Compiles an author pattern with re2js (at most `PATTERN_MAX_LENGTH` characters and a program of at most
 * `PATTERN_MAX_PROGRAM` instructions). `test` searches the value
 * (an unanchored match, like `RegExp.prototype.test`); anchor with `^…$` to match the whole value.
 * `test` itself does not check `PATTERN_COST_BUDGET`; callers matching respondent values use `withinBudget`.
 */
export const compilePattern = (pattern: SafePattern): CompiledPattern => cached(pattern.source, pattern.flags, true);

/** Built-in sources (presets, masks) have no length cap; masks are author input, so the program budget still applies. */
export const compileBuiltIn = (source: string): CompiledPattern => cached(source, '', false);

/** Why a pattern cannot be used, or null when it compiles (builder inline error, B12). */
export function patternProblem(pattern: SafePattern): string | null {
  const compiled = compilePattern(pattern);
  return compiled.ok ? null : compiled.message;
}
