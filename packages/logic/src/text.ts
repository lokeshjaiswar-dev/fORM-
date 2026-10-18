import { graphemeLength } from '@form/i18n';
import { CASE_FOLD_RUNS, CASE_FOLD_UNICODE_VERSION } from './casefold.generated.ts';

/*
 * Text semantics (schema §3.1): values are NFC-normalised, case-insensitive comparisons use the
 * generated simple case folding (CaseFolding.txt C + S), never host toLowerCase(), and lengths count
 * grapheme clusters with the segmenter pinned in @form/i18n, never Intl.Segmenter.
 *
 * NFC uses String.prototype.normalize, the one host Unicode table logic@2 P0 reads (schema §3.1, BL-075):
 * the normalization stability policy fixes the result for every character all engines have assigned; only
 * code points newer than the oldest engine's Unicode version can differ.
 */

export { CASE_FOLD_UNICODE_VERSION };

const FOLD: ReadonlyMap<number, number> = (() => {
  const map = new Map<number, number>();
  for (let i = 0; i + 3 < CASE_FOLD_RUNS.length; i += 4) {
    const start = CASE_FOLD_RUNS[i] ?? 0;
    const count = CASE_FOLD_RUNS[i + 1] ?? 0;
    const delta = CASE_FOLD_RUNS[i + 2] ?? 0;
    const stride = CASE_FOLD_RUNS[i + 3] ?? 1;
    for (let k = 0; k < count; k += 1) {
      const cp = start + k * stride;
      map.set(cp, cp + delta);
    }
  }
  return map;
})();

export const nfc = (text: string): string => text.normalize('NFC');

/** Simple case folding of each code point, then NFC again (folding can leave a decomposed sequence). */
export function caseFold(text: string): string {
  let out = '';
  let changed = false;
  for (const ch of nfc(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    const folded = FOLD.get(cp);
    if (folded === undefined) out += ch;
    else {
      out += String.fromCodePoint(folded);
      changed = true;
    }
  }
  return changed ? nfc(out) : out;
}

/** The comparison form of a text value: NFC, and case-folded unless the condition is case-sensitive. */
export const comparable = (text: string, caseSensitive: boolean): string => (caseSensitive ? nfc(text) : caseFold(text));

export const textLength = (text: string): number => graphemeLength(nfc(text));
