import segmenterPackage from 'unicode-segmenter/package.json';
import { describe, expect, it } from 'vitest';
import { GRAPHEME_UNICODE_VERSION, graphemeLength, graphemes } from '../src/index';
import corpus from './fixtures/graphemes.json';

/** Unicode version of each vetted unicode-segmenter release; a bump must add its row here. */
const SEGMENTER_UNICODE: Readonly<Record<string, string>> = { '0.17.3': '17.0.0' };

const hostUnicode = process.versions.unicode ?? 'unknown';
const sameUnicode = `${hostUnicode}.0` === GRAPHEME_UNICODE_VERSION;
const isCI = Boolean(process.env.CI);
if (!sameUnicode && !isCI) {
  console.warn(`Skipping the Intl.Segmenter cross-check: host Unicode ${hostUnicode}, segmenter ${GRAPHEME_UNICODE_VERSION}.`);
}

/**
 * Golden corpus for the pinned segmenter. The determinism job (WP-0.07) replays this fixture in
 * Chromium, Firefox and WebKit through Playwright and diffs the results byte-for-byte.
 */
describe('pinned grapheme segmenter', () => {
  it('names the Unicode version of the installed unicode-segmenter release', () => {
    expect(SEGMENTER_UNICODE[segmenterPackage.version], `unvetted unicode-segmenter ${segmenterPackage.version}`).toBe(
      GRAPHEME_UNICODE_VERSION,
    );
  });

  it.each(corpus)('$lang: $text', ({ text, graphemes: expected }) => {
    expect(graphemes(text)).toEqual(expected);
    expect(graphemeLength(text)).toBe(expected.length);
  });

  it('applies GB9c to Indic conjuncts (Unicode ≥ 15.1)', () => {
    expect(graphemes('नमस्ते')).toEqual(['न', 'म', 'स्ते']);
    expect(graphemeLength('क्षत्रिय')).toBe(3);
    expect(graphemeLength('ক্ষমা')).toBe(2);
    expect(graphemes('க்ஷ')).toEqual(['க்', 'ஷ']);
  });

  // Runs whenever the host's ICU uses the same Unicode version, and always in CI, where a mismatch fails.
  it.runIf(sameUnicode || isCI)('matches Intl.Segmenter on a host with the same Unicode version', () => {
    expect(`${hostUnicode}.0`, 'the CI Node ICU Unicode version no longer matches the pinned segmenter').toBe(
      GRAPHEME_UNICODE_VERSION,
    );
    const native = new Intl.Segmenter('und', { granularity: 'grapheme' });
    for (const { text } of corpus) {
      expect(graphemes(text)).toEqual([...native.segment(text)].map((s) => s.segment));
    }
  });
});
