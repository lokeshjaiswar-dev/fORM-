import { describe, expect, it } from 'vitest';
import { CORE_PROBLEMS, PROBLEMS, type ProblemCode } from '../errors.ts';
import { ACCESS_PROBLEMS } from './access.ts';
import { FORMS_PROBLEMS } from './forms.ts';
import { PUBLISH_PROBLEMS } from './publish.ts';
import { SUBMISSIONS_PROBLEMS } from './submissions.ts';
import { SUBMIT_PROBLEMS } from './submit.ts';

const FILES = {
  core: CORE_PROBLEMS,
  forms: FORMS_PROBLEMS,
  publish: PUBLISH_PROBLEMS,
  access: ACCESS_PROBLEMS,
  submit: SUBMIT_PROBLEMS,
  submissions: SUBMISSIONS_PROBLEMS,
} as const;

/**
 * `PROBLEMS` spreads one object per domain. A spread lets the later object silently replace an earlier code, so two work
 * packages that both define `VERSION_SUPERSEDED` would not fail anywhere: one status would just vanish.
 */
describe('problem files', () => {
  it('keep ProblemCode a closed union of the keys, which `tsc` checks (a spread must not widen it to string)', () => {
    const listed: ProblemCode = 'NOT_FOUND';
    // @ts-expect-error a code that no file lists is not a ProblemCode
    const unlisted: ProblemCode = 'NOT_A_PROBLEM_CODE';
    expect([listed, unlisted]).toHaveLength(2);
  });

  it('list no code twice', () => {
    const owners = new Map<string, string[]>();
    for (const [file, problems] of Object.entries(FILES)) {
      for (const code of Object.keys(problems)) owners.set(code, [...(owners.get(code) ?? []), file]);
    }
    expect([...owners].filter(([, files]) => files.length > 1)).toEqual([]);
  });

  it('add up to PROBLEMS, each code once', () => {
    const total = Object.values(FILES).map((problems) => Object.keys(problems).length).reduce((a, b) => a + b, 0);
    expect(Object.keys(PROBLEMS)).toHaveLength(total);
  });

  it('give every code an upper-case name, an error status and a title', () => {
    for (const [code, spec] of Object.entries(PROBLEMS)) {
      expect(code, code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(spec.status, code).toBeGreaterThanOrEqual(400);
      expect(spec.status, code).toBeLessThan(600);
      expect(spec.title.length, code).toBeGreaterThan(3);
    }
  });
});
