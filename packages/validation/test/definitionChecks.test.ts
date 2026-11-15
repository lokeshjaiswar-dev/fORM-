import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { PATTERN_MAX_LENGTH, PATTERN_MAX_PROGRAM, patternIssues } from '../src/index.ts';
import { field, form, page } from './build.ts';

/* WP-1.07 / BL-098: publish refuses an author pattern or mask that RE2 cannot run within the program limit. */

const withPattern = (source: string, flags?: '' | 'i'): S.FormDefinition =>
  form([field('short_text', 'code', { config: { pattern: flags === undefined ? { source } : { source, flags } } })], [page('p1', ['code'])]);

const withMask = (pattern: string): S.FormDefinition =>
  form([field('phone', 'mobile', { config: { defaultCountry: 'IN' as S.CountryCode, showCountrySelect: false, mask: { pattern, storeMasked: true } } })], [page('p1', ['mobile'])]);

const one = (def: S.FormDefinition): S.PublishIssue => {
  const issues = patternIssues(def);
  expect(issues).toHaveLength(1);
  return issues[0] as S.PublishIssue;
};

describe('patternIssues', () => {
  it('has nothing to say about a form without patterns or masks, or with safe ones', () => {
    expect(patternIssues(form([field('short_text', 'a'), field('short_text', 'b', { config: { preset: 'in_pan' } })], [page('p1', ['a', 'b'])]))).toEqual([]);
    for (const source of ['^[A-Z]{3}[0-9]+$', '^(?:[a-z]+-)*[a-z]+$', '(?i)^abc$', '\\(?=x', '[(?=]', '^\\p{L}+$']) {
      expect(patternIssues(withPattern(source)), source).toEqual([]);
    }
    expect(patternIssues(withPattern('^abc$', 'i'))).toEqual([]);
    expect(patternIssues(withMask('##-@@-*'))).toEqual([]);
    expect(patternIssues(withMask('(###) ###[-####]'))).toEqual([]);
  });

  it('lets (a+)+$ through on its own: RE2 matches it in linear time, which is why VAL-04 uses it', () => {
    expect(patternIssues(withPattern('(a+)+$'))).toEqual([]);
  });

  it('refuses a backreference, with the path of the pattern source', () => {
    const issue = one(withPattern('(a+)+\\1$'));
    expect(issue).toMatchObject({ severity: 'error', code: 'unsafe_regex', path: '/blocks/code/config/pattern/source' });
    expect(issue.message).toContain('backreferences are not supported');
  });

  it.each(['(?=a+)b$', '(?!x)y', '(?<=a)b', '(?<!a)b', '^(?=.*[0-9])[a-z0-9]+$'])('refuses the lookaround in %s', (source) => {
    const issue = one(withPattern(source));
    expect(issue).toMatchObject({ severity: 'error', code: 'unsafe_regex', path: '/blocks/code/config/pattern/source' });
    expect(issue.message).toContain('lookahead and lookbehind are not supported');
  });

  it('refuses a pattern that compiles to more than PATTERN_MAX_PROGRAM instructions', () => {
    const issue = one(withPattern(`(?:\\pL|b){${PATTERN_MAX_PROGRAM}}`));
    expect(issue).toMatchObject({ severity: 'error', code: 'unsafe_regex', path: '/blocks/code/config/pattern/source' });
    expect(issue.message).toContain('too complex');
  });

  it('refuses a pattern over PATTERN_MAX_LENGTH even when the twin was not run', () => {
    const issue = one(withPattern('a'.repeat(PATTERN_MAX_LENGTH + 1)));
    expect(issue).toMatchObject({ severity: 'error', code: 'unsafe_regex', path: '/blocks/code/config/pattern/source' });
    expect(issue.message).toContain(`${PATTERN_MAX_LENGTH} characters`);
    expect(patternIssues(withPattern('a'.repeat(PATTERN_MAX_LENGTH)))).toEqual([]);
  });

  it.each(['(', 'a)', '[a-', '*a', 'a{2,1}', '\\'])('refuses the syntax error in %j', (source) => {
    expect(one(withPattern(source))).toMatchObject({ severity: 'error', code: 'unsafe_regex', path: '/blocks/code/config/pattern/source' });
  });

  it('checks the mask of a short-text block and of a phone block, each at its own path', () => {
    const def = form([
      field('short_text', 'tail', { config: { mask: { pattern: '##[', storeMasked: true } } }),
      field('phone', 'mobile', { config: { defaultCountry: 'IN' as S.CountryCode, showCountrySelect: false, mask: { pattern: ']##', storeMasked: false } } }),
    ], [page('p1', ['tail', 'mobile'])]);
    const issues = patternIssues(def);
    expect(issues.map((i) => `${i.severity}:${i.code}:${i.path}`)).toEqual([
      'error:unsafe_regex:/blocks/tail/config/mask/pattern',
      'error:unsafe_regex:/blocks/mobile/config/mask/pattern',
    ]);
    expect(issues[0]?.message).toContain('malformed');
  });

  it('refuses a mask that compiles to more than PATTERN_MAX_PROGRAM instructions', () => {
    const issue = one(withMask('#'.repeat(PATTERN_MAX_PROGRAM + 100)));
    expect(issue).toMatchObject({ severity: 'error', code: 'unsafe_regex', path: '/blocks/mobile/config/mask/pattern' });
    expect(issue.message).toContain('too complex');
  });

  it('reports every offending block, in block order, and escapes the block id in the pointer', () => {
    const def = form([
      field('short_text', 'first', { config: { pattern: { source: '(' } } }),
      field('short_text', 'fine', { config: { pattern: { source: '^a$' } } }),
      field('short_text', 'a/b~c', { config: { pattern: { source: '(?=x)' }, mask: { pattern: '##[', storeMasked: true } } }),
    ], [page('p1', ['first', 'fine', 'a/b~c'])]);
    expect(patternIssues(def).map((i) => i.path)).toEqual([
      '/blocks/first/config/pattern/source',
      '/blocks/a~1b~0c/config/pattern/source',
      '/blocks/a~1b~0c/config/mask/pattern',
    ]);
  });

  it('only reads blocks that hold a regex: a date `pattern` is a format name, not a regex', () => {
    const def = form([field('date', 'when', { config: { pattern: 'DD-MM-YYYY', picker: 'calendar' } })], [page('p1', ['when'])]);
    expect(patternIssues(def)).toEqual([]);
  });
});
