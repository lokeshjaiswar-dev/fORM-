import { htmlToInline, htmlToPlain } from '../../src/index.ts';
import type { CountryCode, IsoInstant, Locale, MigrationContext, TimeZone } from '../../src/index.ts';

/** A stand-in for the re2js check of @form/validation: valid syntax, ≤ 256 characters, no backreferences or lookaround (not RE2). */
export function isSafePatternForTests(source: string): boolean {
  if (source.length > 256 || /\\[1-9]|\\k<|\(\?<?[=!]/.test(source)) return false;
  try {
    new RegExp(source, 'u');
    return true;
  } catch {
    return false;
  }
}

/** Sequential ids `<seed>_1`, `<seed>_2`, …: the seeded `idFactory` of the golden outputs. */
export function seededIds(seed: string): () => string {
  let n = 0;
  return () => `${seed}_${(n += 1)}`;
}

/** The MigrationContext of the corpus tests for a given registry: en-IN, Asia/Kolkata, India. */
export function migrationContext(registry: MigrationContext['registry'], seed = 'm'): MigrationContext {
  return {
    idFactory: seededIds(seed),
    now: '2026-10-18T00:00:00Z' as IsoInstant,
    orgDefaults: { locale: 'en-IN' as Locale, timeZone: 'Asia/Kolkata' as TimeZone, country: 'IN' as CountryCode },
    htmlToInline,
    htmlToPlain,
    isSafePattern: isSafePatternForTests,
    registry,
  };
}
