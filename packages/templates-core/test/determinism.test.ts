import { sha256Jcs } from '@form/schema';
import { describe, expect, it } from 'vitest';
import { runCorpus } from './corpus.ts';

/*
 * The Node leg of the templates-core determinism corpus. The browser legs (Chromium, Firefox, WebKit) run in
 * the CI `determinism` job (`pnpm test:determinism`, determinism/determinism.spec.ts) and compare their bytes
 * with Node's. The digest pins instantiate's output: a change to it changes the ids every client and server
 * derive from the same Idempotency-Key, so it is a format change, not an edit.
 */
describe('determinism corpus (Node)', () => {
  const cases = runCorpus();

  it('covers instantiate, random templates, snippets, the sanitiser corpus and lock fingerprints', () => {
    expect(cases.filter((c) => c.name.startsWith('instantiate_event_'))).toHaveLength(5 * 3 * 2);
    expect(cases.filter((c) => c.name.startsWith('instantiate_random_'))).toHaveLength(80);
    expect(cases.filter((c) => c.name.startsWith('snippet_'))).toHaveLength(15);
    expect(cases.filter((c) => c.name.startsWith('sanitize_'))).toHaveLength(43);
    expect(cases.filter((c) => c.name.startsWith('lock_'))).toHaveLength(2);
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });

  it('is stable from run to run', () => {
    expect(runCorpus()).toEqual(cases);
  });

  it('matches the pinned digest', () => {
    expect(sha256Jcs(cases.map((c) => [c.name, c.json]))).toMatchSnapshot();
  });
});
