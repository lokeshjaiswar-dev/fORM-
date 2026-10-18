import { EN_IN as EN_IN_CATALOGS, createI18n, graphemeLength } from '@form/i18n';
import { SHORT_TEXT_MAX } from '@form/registry';
import { VALIDATION_ERROR_CODES } from '@form/schema';
import type * as S from '@form/schema';
import { RE2JS } from 're2js';
import { describe, expect, it, vi } from 'vitest';
import { issuesOf, valuesFor, wellShaped } from '../src/errors.ts';
import {
  PATTERN_COST_BUDGET, PATTERN_MAX_LENGTH, PATTERN_MAX_PROGRAM, PRESET_SOURCES, addDays, addMonths, ageOn, compilePattern, isUnanswered, maskSource, matchesMask,
  matchesPreset, messageFormatter, normalizeAnswer, normalizeAnswers, patternProblem, relativeDate, withinBudget,
} from '../src/index.ts';
import { EN_IN, a, choices, field, form, id, page } from './build.ts';
import { ans, codes, run } from './helpers.ts';

const date = (v: string) => id<S.IsoDate>(v);

describe('normalizeAnswers (I9)', () => {
  it('drops blank answers and blank optional parts, keeping everything else as typed', () => {
    const raw = {
      t: a.text(''),
      u: a.text('  x '),
      n: null,
      m: ans.raw('multi_choice', { optionIds: ['a'], other: '' }),
      s: ans.raw('single_choice', { optionId: null, other: '' }),
      e: ans.raw('email', { address: 'a@b.co', otpProof: '' }),
      tm: ans.raw('time', { start: '10:00', end: '' }),
      name: ans.raw('full_name', { first: 'Asha', middle: '', last: '' }),
      addr: ans.raw('address', { line1: '', city: '' }),
      mx: ans.raw('matrix', { mode: 'grid', rows: { r1: { c1: '' }, r2: { c1: 'x', c2: '' } } }),
      ms: ans.raw('matrix', { mode: 'multi', rows: { r1: [], r2: ['c1'] } }),
      pay: ans.raw('payment', { currency: 'INR', items: [], couponCode: '', customAmount: '100' }),
      rg: ans.raw('repeating_group', { rows: [{ rowId: 'row_1', values: { c: a.text(''), d: a.text('y') } }] }),
      nps: a.nps(0),
    };
    expect(normalizeAnswers(raw)).toEqual({
      u: a.text('  x '),
      m: ans.raw('multi_choice', { optionIds: ['a'] }),
      e: ans.raw('email', { address: 'a@b.co' }),
      tm: ans.raw('time', { start: '10:00' }),
      name: ans.raw('full_name', { first: 'Asha' }),
      mx: ans.raw('matrix', { mode: 'grid', rows: { r2: { c1: 'x' } } }),
      ms: ans.raw('matrix', { mode: 'multi', rows: { r2: ['c1'] } }),
      pay: ans.raw('payment', { currency: 'INR', customAmount: '100' }),
      rg: ans.raw('repeating_group', { rows: [{ rowId: 'row_1', values: { d: a.text('y') } }] }),
      nps: a.nps(0),
    });
  });

  it('returns the same answer object when nothing is blank, and never modifies its input', () => {
    const answer = ans.raw('multi_choice', { optionIds: ['a'], other: 'x' });
    expect(normalizeAnswer(answer)).toBe(answer);
    const rg = ans.raw('repeating_group', { rows: [{ rowId: 'row_1', values: { d: a.text('y') } }] });
    expect(normalizeAnswer(rg)).toBe(rg);
    const mx = ans.raw('matrix', { mode: 'grid', rows: { r1: { c1: 'x' } } });
    expect(normalizeAnswer(mx)).toBe(mx);
    const blank = ans.raw('multi_choice', { optionIds: ['a'], other: '' });
    normalizeAnswer(blank);
    expect(blank).toEqual(ans.raw('multi_choice', { optionIds: ['a'], other: '' }));
  });

  it('keeps values it cannot judge for validation to report', () => {
    expect(normalizeAnswer(ans.raw('short_text', 5))).toEqual(ans.raw('short_text', 5));
    expect(normalizeAnswer(ans.raw('mystery', 'x'))).toEqual(ans.raw('mystery', 'x'));
    expect(normalizeAnswer('loose' as unknown as S.AnswerValue)).toBe('loose');
    expect(isUnanswered(ans.raw('email', 'not an object'))).toBe(false);
    expect(isUnanswered(ans.raw('email', 7))).toBe(false);
    expect(isUnanswered(ans.raw('rating', 0))).toBe(false);
    expect(isUnanswered(ans.raw('ranking', []))).toBe(true);
  });
});

describe('patterns (re2js, VAL-04)', () => {
  it('caps author patterns at 256 characters and reports RE2 syntax errors', () => {
    expect(compilePattern({ source: 'a'.repeat(PATTERN_MAX_LENGTH) }).ok).toBe(true);
    expect(compilePattern({ source: 'a'.repeat(PATTERN_MAX_LENGTH + 1) })).toMatchObject({ ok: false, reason: 'too_long' });
    expect(compilePattern({ source: '(?=a)a' })).toMatchObject({ ok: false, reason: 'syntax' });
    expect(compilePattern({ source: '(a)\\1' })).toMatchObject({ ok: false, reason: 'syntax' });
    expect(patternProblem({ source: '[' })).toMatch(/missing closing/);
    expect(patternProblem({ source: '^[0-9]+$' })).toBeNull();
  });

  it('refuses patterns whose compiled program is over the budget, however short the source', () => {
    /* 240 characters, 16,002 instructions: re2js falls back to the NFA and took about 25 s on a 10,000-character value. */
    const costly = '(?:\\pL|b){1000}'.repeat(16);
    expect(costly.length).toBeLessThanOrEqual(PATTERN_MAX_LENGTH);
    expect(compilePattern({ source: costly })).toMatchObject({ ok: false, reason: 'too_complex' });
    expect(patternProblem({ source: costly })).toMatch(/too complex \(16002 instructions, at most 1000\)/);
    expect(compilePattern({ source: 'a{1000}' })).toMatchObject({ ok: false, reason: 'too_complex' });
    expect(compilePattern({ source: '^(?:\\pL|b){499}$' }).ok).toBe(true);
    const emailLike = "^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$";
    expect(compilePattern({ source: emailLike }).ok).toBe(true);
    expect(PATTERN_MAX_PROGRAM).toBe(1000);
  });

  it('keeps every preset and the longest mask under the program budget', () => {
    for (const [preset, source] of Object.entries(PRESET_SOURCES)) {
      /* Presets skip PATTERN_COST_BUDGET (formats.ts): they must stay small and anchored at both ends. */
      expect(compilePattern({ source }), preset).toMatchObject({ ok: true, size: expect.toSatisfy((n: number) => n < 50) });
      expect(source.startsWith('^') && source.endsWith('$'), preset).toBe(true);
    }
    for (const slot of ['#', '@', '*']) expect(matchesMask({ pattern: slot.repeat(64), storeMasked: true }, '1'.repeat(64)), slot).not.toBeNull();
  });

  it('reports too_long alone and runs no regex on a value over the length limit', () => {
    const block = field('short_text', 'f', { config: { pattern: { source: '^a+$' }, preset: 'alphabetic', mask: { pattern: '@', storeMasked: true } } });
    const def = form([block], [page('p1', ['f'])]);
    const search = vi.spyOn(RE2JS.prototype, 'test');
    try {
      expect(codes(run(def, { f: a.text('a'.repeat(SHORT_TEXT_MAX + 1)) }).errors)).toEqual(['f too_long']);
      expect(search).not.toHaveBeenCalled();
      const capped = form([field('short_text', 'f', { config: { maxLength: 3, pattern: { source: '^b+$' } } })], [page('p1', ['f'])]);
      expect(codes(run(capped, { f: a.text('aaaa') }).errors)).toEqual(['f too_long']);
      expect(search).not.toHaveBeenCalled();
    } finally {
      search.mockRestore();
    }
    expect(codes(run(def, { f: a.text('a') }).errors)).toEqual([]);
  });

  it('runs an author pattern or mask only within PATTERN_COST_BUDGET (program size x value length)', () => {
    /* The worst shape under PATTERN_MAX_PROGRAM: every position starts a thread that can live 990 steps. */
    const source = '(?:[\\pL\\pN]|b){990}$';
    const compiled = compilePattern({ source });
    expect(compiled).toMatchObject({ ok: true, size: 993 });
    const fits = Math.floor(PATTERN_COST_BUDGET / 993);
    expect(PATTERN_COST_BUDGET).toBe(250_000);
    expect(withinBudget({ size: 993 }, 'a'.repeat(fits))).toBe(true);
    expect(withinBudget({ size: 993 }, 'a'.repeat(fits + 1))).toBe(false);
    const def = form([field('short_text', 'f', { config: { pattern: { source } } })], [page('p1', ['f'])]);
    const search = vi.spyOn(RE2JS.prototype, 'test');
    try {
      expect(codes(run(def, { f: a.text('a'.repeat(10_000)) }).errors)).toEqual(['f pattern']);
      expect(search).not.toHaveBeenCalled();
      expect(codes(run(def, { f: a.text('a'.repeat(fits)) }).errors)).toEqual(['f pattern']);
      expect(search).toHaveBeenCalledTimes(1);
      const shorter = form([field('short_text', 'f', { config: { pattern: { source: '(?:[\\pL\\pN]|b){200}$' } } })], [page('p1', ['f'])]);
      expect(codes(run(shorter, { f: a.text('a'.repeat(Math.floor(PATTERN_COST_BUDGET / 203))) }).errors)).toEqual([]);
      expect(codes(run(shorter, { f: a.text('a'.repeat(Math.floor(PATTERN_COST_BUDGET / 203) + 1)) }).errors)).toEqual(['f pattern']);
      expect(search).toHaveBeenCalledTimes(2);
      search.mockClear();
      const mask = { pattern: '#'.repeat(64), storeMasked: true };
      expect(matchesMask(mask, '1'.repeat(64))).toBe(true);
      expect(matchesMask(mask, '1'.repeat(PATTERN_COST_BUDGET))).toBe(false);
      expect(search).toHaveBeenCalledTimes(1);
    } finally {
      search.mockRestore();
    }
  });

  it('matches long valid values made of multi-code-unit graphemes within the length limit', () => {
    /* Over 40,000 code units (the old input cap), under the answer twin's 50,000 and under 10,000 graphemes. */
    const emoji = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'.repeat(4500);
    const devanagari = 'स्त्री'.repeat(8000);
    expect([graphemeLength(emoji), emoji.length]).toEqual([4500, 49_500]);
    expect([graphemeLength(devanagari), devanagari.length]).toEqual([8000, 48_000]);
    const def = form(
      [field('short_text', 'e', { config: { preset: 'no_spaces' } }), field('short_text', 'd', { config: { preset: 'alphabetic' } })],
      [page('p1', ['e', 'd'])],
    );
    expect(codes(run(def, { e: a.text(emoji), d: a.text(devanagari) }).errors)).toEqual([]);
    expect(codes(run(def, { e: a.text(`${emoji.slice(0, -11)} `), d: a.text(`${devanagari.slice(0, -6)}1`) }).errors)).toEqual(['e preset', 'd preset']);
  });

  it('uses RE2 semantics, not the host RegExp', () => {
    const t = (source: string, value: string, flags: '' | 'i' = '') => {
      const compiled = compilePattern({ source, flags });
      return compiled.ok && compiled.test(value);
    };
    expect(t('^a\\sb$', `a${String.fromCharCode(0xa0)}b`)).toBe(false);
    expect(/^a\sb$/.test(`a${String.fromCharCode(0xa0)}b`)).toBe(true);
    expect(t('^\\w+$', 'नमस्ते')).toBe(false);
    expect(t('^[\\p{L}\\p{M}]+$', 'नमस्ते')).toBe(true);
    expect(t('^σ$', 'Σ', 'i')).toBe(true);
    expect(t('^σ$', 'ς', 'i')).toBe(true);
    expect(t('[0-9]', 'ab1')).toBe(true);
  });

  it('caches compiled patterns and survives cache turnover', () => {
    const first = compilePattern({ source: '^x$' });
    expect(compilePattern({ source: '^x$' })).toBe(first);
    for (let i = 0; i < 600; i += 1) compilePattern({ source: `^x${i}$` });
    expect(compilePattern({ source: '^x$' }).ok).toBe(true);
  });
});

describe('presets and masks', () => {
  it('accepts and rejects each preset by format', () => {
    const cases: Record<S.TextPreset, [string[], string[]]> = {
      alphabetic: [['Asha', 'नमस्ते', 'Zoë'], ['Asha1', 'a b', '']],
      alphanumeric: [['Flat12', 'घर१२'], ['a-b', 'a b']],
      numeric: [['0042'], ['4.2', '४२']],
      no_spaces: [['a-b_c'], ['a b', `a${String.fromCharCode(0xa0)}b`, `a${String.fromCharCode(0x3000)}b`, 'a\tb']],
      in_pan: [['ABCPE1234F', 'AAACB1234C'], ['ABCDE1234F', 'abcpe1234f', 'ABCPE12345']],
      in_gstin: [['27AAPFU0939F1ZV'], ['27AAPFU0939F1V', '27AAPFU0939F0ZV']],
      in_pincode: [['560001'], ['056001', '56001']],
      in_ifsc: [['SBIN0001234'], ['SBIN1001234', 'SBI00012345']],
      in_vehicle_reg: [['KA01AB1234', 'KA 01 AB 1234', 'DL-3C-1234', '22BH1234AA'], ['K01AB1234', 'KA01AB123']],
      in_aadhaar_last4: [['1234'], ['123', '12345', '1234 5678 9012']],
    };
    expect(Object.keys(cases).sort()).toEqual(Object.keys(PRESET_SOURCES).sort());
    for (const [preset, [good, bad]] of Object.entries(cases) as Array<[S.TextPreset, [string[], string[]]]>) {
      for (const v of good) expect(matchesPreset(preset, v), `${preset} ${v}`).toBe(true);
      for (const v of bad) expect(matchesPreset(preset, v), `${preset} ${v}`).toBe(false);
    }
  });

  it('compiles masks to anchored RE2 and refuses malformed ones', () => {
    expect(maskSource({ pattern: '##/@@', storeMasked: true })).toBe('^[0-9][0-9]/[\\p{L}\\p{M}][\\p{L}\\p{M}]$');
    expect(maskSource({ pattern: '##/@@', storeMasked: false })).toBe('^[0-9][0-9][\\p{L}\\p{M}][\\p{L}\\p{M}]$');
    for (const pattern of ['##[#', '##]', '#[#]#', '[#][#]', '#]#[']) expect(maskSource({ pattern, storeMasked: true }), pattern).toBeNull();
    expect(matchesMask({ pattern: '[#', storeMasked: true }, '1')).toBeNull();
    expect(matchesMask({ pattern: '***-###', storeMasked: true }, 'AB1-234')).toBe(true);
    expect(matchesMask({ pattern: '(###) ###', storeMasked: true }, '(080) 123')).toBe(true);
    expect(matchesMask({ pattern: '(###) ###', storeMasked: true }, '080123')).toBe(false);
    expect(matchesMask({ pattern: '(###) ###', storeMasked: false }, '080123')).toBe(true);
    expect(matchesMask({ pattern: '##[-##]', storeMasked: true }, '12-3')).toBe(false);
    expect(matchesMask({ pattern: '#'.repeat(64), storeMasked: true }, '1'.repeat(64))).toBe(true);
  });
});

describe('calendar arithmetic', () => {
  it('adds days, months and years with month-end clamping', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDays('2026-10-18', -36_525)).toBe('1926-10-18');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-01-15', -13)).toBe('2024-12-15');
    expect(addDays('0001-01-01', -1)).toBe('0000-12-31');
    expect(addDays('0000-01-01', -1)).toBe('-0001-12-31');
    const today = date('2026-10-18');
    expect(relativeDate(today, { kind: 'relative', offset: -2, unit: 'week' })).toBe('2026-10-04');
    expect(relativeDate(today, { kind: 'relative', offset: 1, unit: 'year' })).toBe('2027-10-18');
    expect(relativeDate(date('2024-02-29'), { kind: 'relative', offset: 1, unit: 'year' })).toBe('2025-02-28');
  });

  it('counts completed years', () => {
    expect(ageOn(date('2000-10-18'), date('2026-10-18'))).toBe(26);
    expect(ageOn(date('2000-10-19'), date('2026-10-18'))).toBe(25);
    expect(ageOn(date('2008-02-29'), date('2026-02-28'))).toBe(17);
    expect(ageOn(date('2008-02-29'), date('2026-03-01'))).toBe(18);
  });
});

describe('error codes and messages', () => {
  it('every validation code has an en-IN message that formats with the arguments validation passes', () => {
    const def = form([field('short_text', 'f')], [page('p1', ['f'])]);
    const fmt = messageFormatter(def, EN_IN);
    const blocks: S.FieldBlock[] = [
      field('short_text', 'f'), field('long_text', 'f', { config: { rows: 4, limit: { unit: 'words', min: 1, max: 9 } } }), field('number', 'f'),
      field('multi_choice', 'f'), field('ranking', 'f'), field('file_upload', 'f', { config: { ...field('file_upload', 'x').config, minFiles: 1, minFileBytes: 10 } }),
      field('rating', 'f'), field('nps', 'f'), field('linear_scale', 'f'), field('repeating_group', 'f'), field('email', 'f'),
    ];
    const i18n = createI18n('en-IN', EN_IN_CATALOGS);
    for (const code of VALIDATION_ERROR_CODES) {
      expect(i18n.has(`system:${code}`), code).toBe(true);
      for (const block of blocks) {
        const values = valuesFor(block, { code, path: [] }, fmt);
        const message = fmt.format(code, values, block);
        expect(message, `${code} on ${block.type}`).not.toMatch(/^system:|\{|\}/);
        expect(message.length).toBeGreaterThan(0);
      }
    }
  });

  it('maps twin issues by type and kind', () => {
    const issue = (fields: Record<string, unknown>) => ({ issues: [{ path: [], ...fields }] });
    expect(issuesOf('ranking', issue({ code: 'too_big', origin: 'array', maximum: 3 }))).toEqual([{ code: 'too_many_selected', path: [], limit: 3 }]);
    expect(issuesOf('file_upload', issue({ code: 'too_small', origin: 'array', minimum: 1 }))).toEqual([{ code: 'too_few_files', path: [], limit: 1 }]);
    expect(issuesOf('short_text', issue({ code: 'too_small', origin: 'string', minimum: 1 }))).toEqual([{ code: 'required', path: [], limit: 1 }]);
    expect(issuesOf('multi_choice', { issues: [{ code: 'too_small', origin: 'string', path: ['other'], minimum: 1n }] })).toEqual([{ code: 'too_short', path: ['other'], limit: 1 }]);
    expect(issuesOf('nps', issue({ code: 'too_small', origin: 'number', minimum: 0 }))).toEqual([{ code: 'below_min', path: [], limit: 0 }]);
    expect(issuesOf('hidden', issue({ code: 'invalid_type' }))).toEqual([{ code: 'invalid_format', path: [] }]);
    expect(issuesOf('url', null)).toEqual([{ code: 'invalid_url', path: [] }]);
    expect(issuesOf('matrix', issue({ code: 'too_big', origin: 'set' }))).toEqual([{ code: 'invalid_format', path: [] }]);
    expect(issuesOf('number', issue({ code: 'custom', params: { code: 'not_a_code' } }))).toEqual([{ code: 'not_a_number', path: [] }]);
    expect(wellShaped({ issues: [{ code: 'custom', params: { code: 'below_min' } }] })).toBe(true);
    expect(wellShaped({ issues: [{ code: 'invalid_type' }] })).toBe(false);
    expect(wellShaped(undefined)).toBe(false);
  });

  it('falls back to the twin bound when the config has none', () => {
    const def = form([field('short_text', 'f')], [page('p1', ['f'])]);
    const fmt = messageFormatter(def, EN_IN);
    const hidden = field('hidden', 'h');
    expect(valuesFor(hidden, { code: 'too_long', path: [], limit: 50_000 }, fmt)).toEqual({ max: 50_000 });
    expect(valuesFor(hidden, { code: 'below_min', path: [], limit: 2 }, fmt)).toEqual({ min: '2' });
    expect(valuesFor(hidden, { code: 'above_max', path: [] }, fmt)).toEqual({ max: '' });
    expect(valuesFor(field('single_choice', 'c', { config: { display: 'radio', options: choices('a'), other: { enabled: true, textRequired: false, maxLength: 9 } } }), { code: 'too_long', path: ['other'] }, fmt)).toEqual({ max: 9 });
    expect(valuesFor(field('number', 'n', { config: { display: 'input', allowNegative: false } }), { code: 'below_min', path: [] }, fmt)).toEqual({ min: '0' });
  });
});
