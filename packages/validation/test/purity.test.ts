import { describe, expect, it } from 'vitest';

/*
 * Validation runs in the browser, the API and the worker and must give the same verdicts everywhere: no host
 * clock, randomness, locale, Unicode table, regex engine or DOM. Author and built-in regexes go through
 * re2js only (VAL-04); the determinism job proves the verdicts in four engines, this keeps the sources honest.
 */

const sources = import.meta.glob<string>('../src/*.ts', { eager: true, query: '?raw', import: 'default' });

const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/\bDate\b/, 'host clock (Date)'],
  [/\bperformance\s*\./, 'host clock (performance)'],
  [/\bMath\.random\b/, 'randomness (Math.random)'],
  [/\bcrypto\s*\./, 'randomness (crypto)'],
  [/\bIntl\b/, 'host locale data (Intl)'],
  [/\.(toLowerCase|toUpperCase|toLocaleLowerCase|toLocaleUpperCase|toLocaleString|localeCompare|normalize)\s*\(/, 'host case mapping, collation or normalisation'],
  [/\b(parseFloat|toFixed|toPrecision)\b/, 'floating point'],
  [/\bnew RegExp\b|\.(test|exec|match|matchAll|search)\(\s*\/|(^|[=(,:]\s*)\/[^/*\s][^/]*\/[gimsuyd]*\.(test|exec)\(/, 'the host RegExp engine on input'],
  [/\b(FileList|File|Blob)\b/, 'DOM file objects'],
  [/\bfrom\s+['"](node:|react)/, 'a Node built-in or React'],
  [/\b(window|document|globalThis)\b/, 'a host global'],
];

/** Drops comments (block and line) so the rules apply to code only. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, '')).replace(/(^|[^:'"])\/\/.*$/gm, '$1');

describe('purity of @form/validation sources', () => {
  it('finds the sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(8);
  });

  it('uses no clock, randomness, locale, host regex, DOM or host global', () => {
    const hits: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      code(text).split('\n').forEach((line, i) => {
        for (const [pattern, what] of FORBIDDEN) if (pattern.test(line)) hits.push(`${file}:${i + 1} ${what}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
