import { jsonPointer, type FormDefinition, type InputMask, type PublishIssue, type SafePattern } from '@form/schema';
import { maskSource } from './formats.ts';
import { compileBuiltIn, compilePattern, patternUnsupportedFeature } from './pattern.ts';

/*
 * Publish-time checks of a whole definition that need the regex engine (WP-1.07, VAL-04, BL-098). A pattern or mask
 * that cannot run is only ignored while a draft is edited (B12: `checks.ts` skips it); it must never reach a published
 * version, where every respondent's answer would meet it. The engine must be installed: the eager `@form/validation`
 * entry does that on import (a browser entry that only renders forms has no use for this module and does not export it).
 */

const unsafe = (path: string, message: string): PublishIssue => ({ severity: 'error', code: 'unsafe_regex', path, message });

/** RE2 refuses these constructs with a terse parse error; saying which one tells the author what to remove. */
const UNSUPPORTED = {
  lookaround: 'lookahead and lookbehind are not supported (patterns run in RE2, which matches in linear time)',
  backref: 'backreferences are not supported (patterns run in RE2, which matches in linear time)',
} as const;

/** The issue for an author pattern that does not compile within the limits, or null when it is fine. */
function patternIssue(pattern: SafePattern, path: string): PublishIssue | null {
  const compiled = compilePattern(pattern);
  if (compiled.ok) return null;
  const feature = compiled.reason === 'syntax' ? patternUnsupportedFeature(pattern.source) : undefined;
  return unsafe(path, `the pattern cannot be used: ${feature === undefined ? compiled.message : UNSUPPORTED[feature]}`);
}

/** The issue for an input mask that is malformed or compiles into too large a program, or null when it is fine. */
function maskIssue(mask: InputMask, path: string): PublishIssue | null {
  const source = maskSource(mask);
  if (source === null) return unsafe(path, 'the input mask is malformed: use # for a digit, @ for a letter, * for either, and at most one [...] optional tail at the end');
  const compiled = compileBuiltIn(source);
  return compiled.ok ? null : unsafe(path, `the input mask cannot be used: ${compiled.message}`);
}

/**
 * VAL-04 at publish: every author pattern (`config.pattern`) and input mask (`config.mask`) in `def` must compile in re2js
 * within `PATTERN_MAX_LENGTH` characters and `PATTERN_MAX_PROGRAM` instructions. An issue has severity `error`, code
 * `unsafe_regex` and the JSON pointer of the offending `source` (pattern) or `pattern` (mask). RE2 has no backreferences
 * or lookaround, so a pasted PCRE/JS pattern that uses them is reported here rather than silently never matching.
 * A pattern that is merely slow on a long value (`(a+)+$`) is linear in RE2 and passes; `PATTERN_COST_BUDGET` bounds it per answer.
 */
export function patternIssues(def: FormDefinition): PublishIssue[] {
  const issues: PublishIssue[] = [];
  for (const [id, block] of Object.entries(def.blocks)) {
    if (block?.type !== 'short_text' && block?.type !== 'phone') continue;
    const at = (...rest: string[]) => jsonPointer('blocks', id, 'config', ...rest);
    if (block.type === 'short_text' && block.config.pattern !== undefined) {
      const issue = patternIssue(block.config.pattern, at('pattern', 'source'));
      if (issue) issues.push(issue);
    }
    if (block.config.mask !== undefined) {
      const issue = maskIssue(block.config.mask, at('mask', 'pattern'));
      if (issue) issues.push(issue);
    }
  }
  return issues;
}
