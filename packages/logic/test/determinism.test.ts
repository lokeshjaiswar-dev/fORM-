import { sha256Jcs } from '@form/schema';
import { describe, expect, it } from 'vitest';
import { runCorpus, runGraphemes } from './corpus/determinism.ts';

/*
 * The Node leg of the determinism corpus. The browser legs (Chromium, Firefox, WebKit) run in the CI
 * `determinism` job (`pnpm test:determinism`, determinism/determinism.spec.ts) and compare their bytes
 * with Node's. The digest below pins logic@2's semantics: a change to it is a new engine id, not an edit.
 */
describe('determinism corpus (Node)', () => {
  const cases = runCorpus();

  it('covers the 35 parity fixtures × 200 answer sets, random forms and the edge-case fixtures', () => {
    expect(cases.filter((c) => !/^(text|numbers|meta|random|caseFold)/.test(c.name))).toHaveLength(35 * 200);
    expect(cases.filter((c) => c.name.startsWith('random_')).length).toBeGreaterThanOrEqual(15 * 20);
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });

  it('is stable from run to run', () => {
    expect(runCorpus()).toEqual(cases);
  });

  it('matches the pinned logic@2 digest', () => {
    expect(sha256Jcs(cases.map((c) => [c.name, c.json]))).toMatchSnapshot();
  });

  it('replays the pinned grapheme corpus', () => {
    for (const { text, expected, actual } of runGraphemes()) expect(actual, text).toEqual(expected);
  });
});
