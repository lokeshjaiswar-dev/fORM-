import { sha256Jcs } from '@form/schema';
import { describe, expect, it } from 'vitest';
import { REGEX_PATTERNS, runCorpus } from './corpus/determinism.ts';

/*
 * The Node leg of the validation determinism corpus. The browser legs (Chromium, Firefox, WebKit) run in
 * the CI `determinism` job (`pnpm test:determinism`, determinism/determinism.spec.ts) and compare their
 * bytes with Node's. The digest pins the verdicts: re2js, the presets and the error contract.
 */
describe('validation determinism corpus (Node)', () => {
  const cases = runCorpus();

  it('covers the regex corpus, presets, masks and 200 answer sets', () => {
    expect(cases.filter((c) => c.name.startsWith('regex_'))).toHaveLength(REGEX_PATTERNS.length);
    expect(cases.filter((c) => c.name.startsWith('validate_'))).toHaveLength(200);
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });

  it('pins the regex verdicts the acceptance names', () => {
    const verdicts = (source: string) => JSON.parse(cases.find((c) => JSON.parse(c.json).source === source)?.json ?? '{}').verdicts as string;
    /* RE2's \s is ASCII: NBSP is not a space; \w is ASCII: Devanagari is not a word character. */
    expect(verdicts('^a\\sb$').slice(0, 4)).toBe('0100');
    expect(verdicts('^\\w+$')).toMatch(/^0{12}11100/);
    expect(verdicts('(a)\\1')).toBe('invalid:syntax');
    expect(verdicts('a'.repeat(257))).toBe('invalid:too_long');
    /* 240 characters, a 16,002-instruction program: about 25 s on a 10,000-character value before the budget. */
    expect(verdicts('(?:\\pL|b){1000}'.repeat(16))).toBe('invalid:too_complex');
    expect(verdicts('a{1000}')).toBe('invalid:too_complex');
    expect(verdicts('^(?:\\pL|b){499}$')).toMatch(/^[01]+$/);
    const worst = JSON.parse(cases.find((c) => JSON.parse(c.json).source === '(?:[\\pL\\pN]|b){990}$')?.json ?? '{}') as { size: number; verdicts: string };
    expect(worst.size).toBe(993);
    expect(worst.verdicts).toMatch(/^0+$/);
  });

  it('is stable from run to run', () => {
    expect(runCorpus()).toEqual(cases);
  });

  it('matches the pinned digest', () => {
    expect(sha256Jcs(cases.map((c) => [c.name, c.json]))).toMatchSnapshot();
  });
});
