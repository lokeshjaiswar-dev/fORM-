import { collectGraphemes, countGraphemes } from 'unicode-segmenter/grapheme';

/**
 * Unicode version of the bundled grapheme tables (unicode-segmenter, pinned exactly in package.json).
 * Bumping the dependency changes `len` and length validation results, so it is a versioned change.
 */
export const GRAPHEME_UNICODE_VERSION = '17.0.0';

/**
 * Extended grapheme clusters (UAX #29, incl. GB9c Indic conjuncts) from generated tables.
 * Use this, never `Intl.Segmenter`, whose rules follow the host's Unicode version.
 */
export function graphemes(text: string): string[] {
  return collectGraphemes(text);
}

export function graphemeLength(text: string): number {
  return countGraphemes(text);
}
