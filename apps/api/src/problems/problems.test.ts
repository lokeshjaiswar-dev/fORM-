import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORE_PROBLEMS, PROBLEMS, type ProblemCode } from '../errors.ts';
import { ACCESS_PROBLEMS } from './access.ts';
import { EXPORTS_PROBLEMS } from './exports.ts';
import { FORMS_PROBLEMS } from './forms.ts';
import { NOTIFICATIONS_PROBLEMS } from './notifications.ts';
import { PUBLISH_PROBLEMS } from './publish.ts';
import { REVIEWS_PROBLEMS } from './reviews.ts';
import { SUBMISSIONS_PROBLEMS } from './submissions.ts';
import { SUBMIT_PROBLEMS } from './submit.ts';
import { WEBHOOKS_PROBLEMS } from './webhooks.ts';

const FILES = {
  core: CORE_PROBLEMS,
  forms: FORMS_PROBLEMS,
  publish: PUBLISH_PROBLEMS,
  access: ACCESS_PROBLEMS,
  submit: SUBMIT_PROBLEMS,
  submissions: SUBMISSIONS_PROBLEMS,
  reviews: REVIEWS_PROBLEMS,
  notifications: NOTIFICATIONS_PROBLEMS,
  webhooks: WEBHOOKS_PROBLEMS,
  exports: EXPORTS_PROBLEMS,
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

  it('spread every problems/*.ts file into PROBLEMS, also one that lists no code yet (it would otherwise be silently ignored)', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const errors = readFileSync(fileURLToPath(new URL('../errors.ts', import.meta.url)), 'utf8');
    const domains = readdirSync(here).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && f !== 'spec.ts');
    // FILES holds `core` (listed in errors.ts itself) and one entry per domain file: a new file must be added there too, or its codes escape the duplicate check above.
    expect(domains).toHaveLength(Object.keys(FILES).length - 1);
    expect(domains.filter((f) => !errors.includes(`'./problems/${f}'`))).toEqual([]);
  });
});
