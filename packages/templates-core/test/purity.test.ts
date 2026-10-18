import { describe, expect, it } from 'vitest';

/*
 * Architecture §1 rule 4: templates-core reads no clock, randomness, host locale or Unicode tables, so the
 * builder, the API and the worker instantiate the same bytes. The determinism job proves it on the corpus;
 * this keeps the sources honest.
 */

const sources = import.meta.glob<string>('../src/*.ts', { eager: true, query: '?raw', import: 'default' });

const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/\bDate\b/, 'host clock (Date)'],
  [/\bperformance\s*\./, 'host clock (performance)'],
  [/\bMath\.random\b/, 'randomness (Math.random)'],
  [/\bcrypto\s*\./, 'randomness (crypto)'],
  [/\bIntl\b/, 'host locale data (Intl)'],
  [/\.(toLowerCase|toUpperCase|toLocaleLowerCase|toLocaleUpperCase|toLocaleString|localeCompare|normalize)\s*\(/, 'host case mapping, collation or normalisation'],
  [/\bfrom\s+['"](node:|react)/, 'a Node built-in or React'],
  [/(?<![.\w'/])(window|document|globalThis)\b(?!\s*:)/, 'a host global'],
  [/\/[a-z]*u[a-z]*[,;)\s]/, 'a Unicode-mode regular expression (host Unicode tables)'],
];

/** Drops comments (block and line) so the rules apply to code only. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, '')).replace(/(^|[^:'"])\/\/.*$/gm, '$1');

describe('purity of @form/templates-core sources', () => {
  it('finds the sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(8);
  });

  it('uses no clock, randomness, host locale, Unicode tables or host global', () => {
    const hits: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      code(text).split('\n').forEach((line, i) => {
        for (const [pattern, what] of FORBIDDEN) if (pattern.test(line)) hits.push(`${file}:${i + 1} ${what}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
