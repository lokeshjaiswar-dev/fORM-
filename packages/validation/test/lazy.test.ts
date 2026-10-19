import { evaluate } from '@form/logic';
import { describe, expect, it } from 'vitest';
import { compilePattern, loadRegexEngine, matchesPreset, needsRegexEngine, validateAnswers } from '../src/lazy.ts';
import { EN_IN, META, a, field, form, id, page, versionOf } from './build.ts';

/* The lazy entry (BL-129): nothing installs re2js until loadRegexEngine(). This file imports no eager entry. */

const plain = form([field('short_text', 'name'), field('email', 'mail')], [page('p1', ['name', 'mail'])]);
const withPreset = form([field('short_text', 'pin', { config: { preset: 'in_pincode' } })], [page('p1', ['pin'])]);

describe('@form/validation/lazy', () => {
  it('says which forms need the regex engine', () => {
    expect(needsRegexEngine(plain)).toBe(false);
    expect(needsRegexEngine(withPreset)).toBe(true);
    expect(needsRegexEngine(form([field('short_text', 's', { config: { pattern: { source: '^a$' } } })], [page('p1', ['s'])]))).toBe(true);
    expect(needsRegexEngine(form([field('short_text', 's', { config: { mask: { pattern: '###', storeMasked: true } } })], [page('p1', ['s'])]))).toBe(true);
  });

  it('validates a form without regexes before the engine loads, and refuses a regex until it has', async () => {
    const version = versionOf(plain);
    const state = evaluate(version, {}, META, 'client');
    expect(validateAnswers(version, state, { name: a.text('Asha') }, { scope: 'submit', locale: EN_IN, today: id('2026-10-18') })).toEqual([]);
    expect(() => matchesPreset('in_pincode', '560001')).toThrow(/loadRegexEngine/);

    await Promise.all([loadRegexEngine(), loadRegexEngine()]);
    expect(matchesPreset('in_pincode', '560001')).toBe(true);
    expect(compilePattern({ source: '^a+$' }).ok).toBe(true);
    const pinned = versionOf(withPreset);
    const errors = validateAnswers(pinned, evaluate(pinned, {}, META, 'client'), { pin: a.text('12') }, { scope: 'submit', locale: EN_IN, today: id('2026-10-18') });
    expect(errors.map((e) => e.code)).toEqual(['preset']);
  });
});
