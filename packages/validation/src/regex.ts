import type { RE2JS } from 're2js';
import type { StoredBlock } from '@form/schema';

/*
 * The regex engine (re2js, VAL-04) is installed rather than imported where it runs, so a browser can fetch it only
 * for forms that match text against a pattern, preset or mask (BL-099, BL-129). `@form/validation` installs it
 * when imported; `@form/validation/lazy` leaves it to `loadRegexEngine()`, which callers await before validating
 * a form for which `needsRegexEngine` is true.
 */

export type RegexEngine = typeof RE2JS;

let engine: RegexEngine | undefined;

export function installRegexEngine(re2: RegexEngine): void {
  engine = re2;
}

/** The installed engine; throws when a lazy caller validates before `loadRegexEngine()` resolved. */
export function regexEngine(): RegexEngine {
  if (!engine) throw new Error('@form/validation: the regex engine is not loaded; await loadRegexEngine() first');
  return engine;
}

export const regexEngineInstalled = (): boolean => engine !== undefined;

/** Whether validating `definition` can match text with the regex engine: a short-text block with a preset, pattern or mask. */
export const needsRegexEngine = (definition: { blocks: Readonly<Record<string, StoredBlock | undefined>> }): boolean =>
  Object.values(definition.blocks).some(
    (block) => block?.type === 'short_text' && (block.config.preset !== undefined || block.config.pattern !== undefined || block.config.mask !== undefined),
  );
