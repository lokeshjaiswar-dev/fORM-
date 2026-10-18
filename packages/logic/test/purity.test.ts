import { describe, expect, it } from 'vitest';

/*
 * Schema §3.3.13: the engine reads no host clock, randomness, locale or Unicode table, so every engine
 * computes the same bytes. The determinism job proves it on the corpus; this keeps the sources honest.
 */

const sources = import.meta.glob<string>('../src/*.ts', { eager: true, query: '?raw', import: 'default' });

const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/\bDate\b/, 'host clock (Date)'],
  [/\bperformance\s*\./, 'host clock (performance)'],
  [/\bMath\.random\b/, 'randomness (Math.random)'],
  [/\bcrypto\s*\./, 'randomness (crypto)'],
  [/\bIntl\b/, 'host locale data (Intl)'],
  [/\.(toLowerCase|toUpperCase|toLocaleLowerCase|toLocaleUpperCase|toLocaleString|localeCompare)\s*\(/, 'host case mapping or collation'],
  [/\b(parseFloat|toFixed|toPrecision)\b/, 'floating point'],
  [/\bfrom\s+['"](node:|react)/, 'a Node built-in or React'],
  [/\b(window|document|globalThis)\b/, 'a host global'],
];

/** Drops comments (block and line) so the rules apply to code only. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, '')).replace(/(^|[^:'"])\/\/.*$/gm, '$1');

describe('purity of @form/logic sources', () => {
  it('finds the sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  it('uses no clock, randomness, locale, float formatting or host global', () => {
    const hits: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      code(text).split('\n').forEach((line, i) => {
        for (const [pattern, what] of FORBIDDEN) if (pattern.test(line)) hits.push(`${file}:${i + 1} ${what}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
