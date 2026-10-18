import { createI18n } from '@form/i18n';
import { evaluate } from '@form/logic';
import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { normalizeAnswers, validateAnswers } from '../src/index.ts';
import {
  EN_IN, META, a, ans as ref, bid, choices, cond, disable, field, form, heading, hide, id, num, oid, page, pid, requireIt, rule, show, text, unrequire, versionOf,
} from './build.ts';
import { TODAY, ans, codes, onPage, run } from './helpers.ts';

const threePages = () => form(
  [field('short_text', 'a'), field('short_text', 'b', { required: true }), field('short_text', 'c', { required: true })],
  [page('p1', ['a']), page('p2', ['b']), page('p3', ['c'])],
);

describe('scope (VAL-10, RSP-02)', () => {
  it('B1: Next validates only the current page', () => {
    const def = threePages();
    expect(codes(run(def, {}, onPage('p1')).errors)).toEqual([]);
    expect(codes(run(def, {}, onPage('p2')).errors)).toEqual(['b required']);
    expect(codes(run(def, { b: a.text('x') }, onPage('p3')).errors)).toEqual(['c required']);
    expect(codes(run(def, {}).errors)).toEqual(['b required', 'c required']);
  });

  it('B1: a page off the path, or unknown, has nothing to validate', () => {
    const def = form(
      [field('short_text', 'a'), field('short_text', 'b', { required: true })],
      [page('p1', ['a']), page('p2', ['b'], { initiallyHidden: true })],
    );
    expect(codes(run(def, {}, onPage('p2')).errors)).toEqual([]);
    expect(codes(run(def, {}, onPage('nowhere')).errors)).toEqual([]);
    expect(codes(run(def, {}).errors)).toEqual([]);
  });

  it('B2: a hidden required field does not block submit, and one shown by logic does', () => {
    const def = form(
      [field('short_text', 'country'), field('short_text', 'state', { required: true, initiallyHidden: true })],
      [page('p1', ['country', 'state'])],
      [rule('r1', cond(ref('country'), 'eq', text('IN')), [show('state')])],
    );
    expect(codes(run(def, {}).errors)).toEqual([]);
    expect(codes(run(def, { country: a.text('US') }).errors)).toEqual([]);
    expect(codes(run(def, { country: a.text('IN') }).errors)).toEqual(['state required']);
  });

  it('B2: a hidden field is not validated at all, even with a bad answer', () => {
    const def = form(
      [field('short_text', 'toggle'), field('email', 'mail', { required: true })],
      [page('p1', ['toggle', 'mail'])],
      [rule('r1', cond(ref('toggle'), 'eq', text('hide')), [hide('mail')])],
    );
    expect(codes(run(def, { toggle: a.text('hide'), mail: a.email('nope') }).errors)).toEqual([]);
    expect(codes(run(def, { toggle: a.text('show'), mail: a.email('nope') }).errors)).toEqual(['mail.address invalid_email']);
  });

  it('requires the effective required set: require / unrequire rules, disabled fields', () => {
    const def = form(
      [field('number', 'age'), field('short_text', 'guardian'), field('short_text', 'note', { required: true }), field('short_text', 'locked', { required: true })],
      [page('p1', ['age', 'guardian', 'note', 'locked'])],
      [
        rule('r1', cond(ref('age'), 'lt', num('18')), [requireIt('guardian'), unrequire('note')]),
        rule('r2', cond(ref('age'), 'is_answered'), [disable('locked')]),
      ],
    );
    expect(codes(run(def, {}).errors)).toEqual(['note required', 'locked required']);
    expect(codes(run(def, { age: a.number('12') }).errors)).toEqual(['guardian required']);
    expect(codes(run(def, { age: a.number('40'), locked: a.email('x@y.co') }).errors)).toEqual(['note required']);
  });

  it('skips a read-only required field without a value, and validates it when it has one', () => {
    const def = form([field('short_text', 'ro', { required: true, readOnly: true, config: { maxLength: 2 } })], [page('p1', ['ro'])]);
    expect(codes(run(def, {}).errors)).toEqual([]);
    expect(codes(run(def, { ro: a.text('long') }).errors)).toEqual(['ro too_long']);
  });

  it('validates hidden fields on their captured value, never on a submitted one', () => {
    const def = form(
      [
        field('hidden', 'src', { required: true, config: { source: { kind: 'static', value: ['web'] } } }),
        field('hidden', 'utm', { required: true, config: { source: { kind: 'utm', param: 'source' } } }),
      ],
      [page('p1', ['src', 'utm'])],
    );
    expect(codes(run(def, { src: a.hidden('forged') }).errors)).toEqual(['utm required']);
  });

  it('ignores answers for blocks that are not fields, unknown or computed', () => {
    const def = form([field('short_text', 'a', { required: true }), heading('h')], [page('p1', ['a', 'h'])]);
    const junk = { ghost: a.text('y'), h: a.text('z'), ctx: a.number('1'), calc: a.text('not a number'), uid: a.nps(99) };
    expect(codes(run(def, { a: a.text('x'), ...junk }).errors)).toEqual([]);
    expect(codes(run(def, junk).errors)).toEqual(['a required']);
    /* This version does not compile computed fields yet (x-field capabilities), so they are spliced into a compiled one, visible and required. */
    const computed = [
      field('context', 'ctx', { required: true, config: { source: 'page_url' } }),
      field('calculation', 'calc', { required: true }),
      field('unique_id', 'uid', { required: true }),
    ];
    const base = versionOf(def);
    const ids = computed.map((b) => b.id);
    const version: S.FormVersion = {
      ...base,
      definition: { ...def, blocks: { ...def.blocks, ...Object.fromEntries(computed.map((b) => [b.id, b])) }, pages: [page('p1', ['a', 'h', 'ctx', 'calc', 'uid'])] },
      compiled: { ...base.compiled, documentOrder: [...base.compiled.documentOrder, ...ids], pageOf: { ...base.compiled.pageOf, ...Object.fromEntries(ids.map((i) => [i, pid('p1')])) } },
    };
    const evaluated = evaluate(base, normalizeAnswers(junk), META, 'client');
    const state: S.EvalState = { ...evaluated, visible: new Set([...evaluated.visible, ...ids]), required: new Set([...evaluated.required, ...ids]) };
    for (const scope of ['submit', { page: pid('p1') }] as const) {
      expect(codes(validateAnswers(version, state, junk, { scope, locale: EN_IN, today: TODAY }))).toEqual(['a required']);
    }
  });

  it('runs with document undefined (no DOM, no FileList)', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof FileList).toBe('undefined');
    expect(codes(run(threePages(), {}).errors)).toEqual(['b required', 'c required']);
  });

  it('orders errors by document order, not by page or answer order', () => {
    const def = form(
      [field('short_text', 'z', { required: true }), field('number', 'y', { config: { display: 'input', min: id<S.DecimalString>('5') } })],
      [page('p1', ['y']), page('p2', ['z'])],
    );
    expect(codes(run(def, { y: a.number('1') }).errors)).toEqual(['y below_min', 'z required']);
  });

  it('puts required first within a block', () => {
    const def = form([field('signature', 's', { config: { penColor: { token: 'text' }, heightPx: 160, allowTyped: false } })], [page('p1', ['s'])]);
    expect(codes(run(def, { s: ans.signature('typed', '  ') }).errors)).toEqual(['s.typedName required', 's.method invalid_format']);
  });
});

describe('fixed v1 bugs', () => {
  it('B7: an unanswered NPS or scale is absent, and 0 is a real NPS answer', () => {
    const def = form([field('nps', 'n', { required: true }), field('linear_scale', 's', { required: true, config: { min: 0, max: 5 } })], [page('p1', ['n', 's'])]);
    expect(codes(run(def, {}).errors)).toEqual(['n required', 's required']);
    expect(codes(run(def, { n: a.nps(0), s: ans.scale(0) }).errors)).toEqual([]);
  });

  it('B8: a required ranking fails until the respondent ranks every position', () => {
    const def = form([field('ranking', 'r', { required: true, config: { options: choices('a', 'b', 'c') } })], [page('p1', ['r'])]);
    expect(codes(run(def, {}).errors)).toEqual(['r required']);
    expect(codes(run(def, { r: ans.ranking('b', 'a') }).errors)).toEqual(['r too_few_selected']);
    expect(run(def, { r: ans.ranking('b', 'a') }).errors[0]?.message).toBe('Select at least 3 options.');
    expect(codes(run(def, { r: ans.ranking('b', 'a', 'c') }).errors)).toEqual([]);
  });

  it('B9: an optional choice left empty is unanswered, not an error', () => {
    const def = form(
      [field('single_choice', 's', { config: { display: 'radio', options: choices('a') } }), field('multi_choice', 'm', { config: { display: 'checkbox', options: choices('a') } })],
      [page('p1', ['s', 'm'])],
    );
    expect(codes(run(def, { s: a.single(null), m: a.multi() }).errors)).toEqual([]);
    expect(codes(run(def, { s: null, m: undefined }).errors)).toEqual([]);
  });

  it('B13: an email uses its custom error message, for every code it sets', () => {
    const def = form(
      [field('email', 'e', {
        required: true,
        config: { allowedDomains: ['corp.com'] },
        messages: { invalid_email: 'Use your work email', email_domain_blocked: 'Only corp.com addresses' },
      })],
      [page('p1', ['e'])],
    );
    expect(run(def, { e: a.email('nope') }).errors.map((e) => e.message)).toEqual(['Use your work email']);
    expect(run(def, { e: a.email('a@gmail.com') }).errors.map((e) => e.message)).toEqual(['Only corp.com addresses']);
    expect(run(def, {}).errors.map((e) => e.message)).toEqual(['This field is required.']);
  });

  it('B14: an empty required number says Required, a non-number says Enter a number', () => {
    const def = form([field('number', 'n', { required: true })], [page('p1', ['n'])]);
    expect(run(def, { n: ans.raw('number', '') }).errors.map((e) => [e.code, e.message])).toEqual([['required', 'This field is required.']]);
    expect(run(def, { n: ans.raw('number', 'abc') }).errors.map((e) => [e.code, e.message])).toEqual([['not_a_number', 'Enter a number.']]);
    expect(run(def, { n: ans.raw('number', Number.NaN) }).errors.map((e) => e.code)).toEqual(['not_a_number']);
  });

  it('optional text with a minimum length or a pattern accepts an empty answer (found in WP-0.02)', () => {
    const def = form([field('short_text', 't', { config: { minLength: 3, pattern: { source: '^[0-9]+$' } } })], [page('p1', ['t'])]);
    expect(codes(run(def, { t: a.text('') }).errors)).toEqual([]);
  });
});

describe('messages (VAL-05, VAL-07, VAL-08)', () => {
  it('formats en-IN messages with the block limits', () => {
    const def = form(
      [
        field('number', 'n', { config: { display: 'input', min: id<S.DecimalString>('1000'), max: id<S.DecimalString>('100000'), step: id<S.DecimalString>('0.5') } }),
        field('short_text', 't', { config: { minLength: 3 } }),
        field('file_upload', 'f', { config: { ...field('file_upload', 'x').config, maxFileBytes: 5 * 1024 * 1024 } }),
      ],
      [page('p1', ['n', 't', 'f'])],
    );
    const messages = (raw: Record<string, S.AnswerValue>) => run(def, raw).errors.map((e) => e.message);
    expect(messages({ n: a.number('5') })).toEqual(['Enter 1,000 or more.']);
    expect(messages({ n: a.number('100001') })).toEqual(['Enter 1,00,000 or less.']);
    expect(messages({ n: a.number('1000.25') })).toEqual(['Enter a multiple of 0.5.']);
    expect(messages({ t: a.text('ab') })).toEqual(['Enter at least 3 characters.']);
    expect(messages({ f: ans.files({ sizeBytes: 6 * 1024 * 1024 }) })).toEqual(['Each file must be 5 MB or smaller.']);
    expect(messages({ f: ans.files({ name: 'x.exe', mime: 'application/x-msdownload' }) })).toEqual(['This file type is not accepted. Allowed types: pdf, jpg, jpeg, png, doc, docx.']);
    expect(run(def, { n: a.number('5') }).errors[0]?.params).toEqual({ min: '1,000' });
  });

  it('prefers the block message, then the form override, then the caller catalogue, then en-IN', () => {
    const HI = id<S.Locale>('hi-IN');
    const base = form([field('short_text', 'a', { required: true, messages: { required: 'Name, please' } }), field('short_text', 'b', { required: true })], [page('p1', ['a', 'b'])]);
    const def: S.FormDefinition = {
      ...base,
      i18n: {
        ...base.i18n,
        locales: [...base.i18n.locales, { locale: HI, direction: 'ltr' }],
        messages: { [HI]: { 'block:a:msg:required': { value: 'नाम लिखें', sourceHash: id<S.Sha256Hex>('c'.repeat(64)), origin: 'human' } } },
        systemMessages: { [EN_IN]: { required: 'Please fill this in' } },
      },
    };
    expect(run(def, {}).errors.map((e) => e.message)).toEqual(['Name, please', 'Please fill this in']);
    const hindi = createI18n('hi-IN', { system: { required: 'यह फ़ील्ड आवश्यक है।' } });
    expect(run(def, {}, 'submit', { locale: HI, messages: hindi }).errors.map((e) => e.message)).toEqual(['नाम लिखें', 'यह फ़ील्ड आवश्यक है।']);
    expect(run(base, {}, 'submit', { locale: HI }).errors.map((e) => e.message)).toEqual(['Name, please', 'This field is required.']);
  });

  it('formats custom messages as ICU with the same arguments, and falls through when one is broken', () => {
    const def = form(
      [field('short_text', 'a', { config: { maxLength: 3 }, messages: { too_long: 'At most {max} letters' } }), field('short_text', 'b', { config: { maxLength: 3 }, messages: { too_long: 'Broken {max' } })],
      [page('p1', ['a', 'b'])],
    );
    expect(run(def, { a: a.text('abcd'), b: a.text('abcd') }).errors.map((e) => e.message)).toEqual(['At most 3 letters', 'Enter no more than 3 characters.']);
  });
});

describe('checks beyond the registry', () => {
  it('matches author patterns in NFC with re2js, ignoring an unusable pattern (B12)', () => {
    const def = form(
      [
        field('short_text', 'p', { config: { pattern: { source: '^caf\\x{E9}$' } } }),
        field('short_text', 'i', { config: { pattern: { source: '^straße$', flags: 'i' } } }),
        field('short_text', 'bad', { config: { pattern: { source: '(a)\\1' } } }),
      ],
      [page('p1', ['p', 'i', 'bad'])],
    );
    expect(codes(run(def, { p: a.text('café'), i: a.text('STRAßE'), bad: a.text('anything') }).errors)).toEqual([]);
    expect(codes(run(def, { p: a.text('cafe'), i: a.text('STRASSE') }).errors)).toEqual(['p pattern', 'i pattern']);
  });

  it('checks presets and masks', () => {
    const def = form(
      [
        field('short_text', 'pan', { config: { preset: 'in_pan' } }),
        field('short_text', 'pin', { config: { preset: 'in_pincode' } }),
        field('short_text', 'm', { config: { mask: { pattern: '#####-####', storeMasked: true } } }),
        field('short_text', 'raw', { config: { mask: { pattern: '##-##[ ext ###]', storeMasked: false } } }),
      ],
      [page('p1', ['pan', 'pin', 'm', 'raw'])],
    );
    const ok = { pan: a.text('ABCPE1234F'), pin: a.text('560001'), m: a.text('12345-6789'), raw: a.text('1234567') };
    expect(codes(run(def, ok).errors)).toEqual([]);
    const bad = { pan: a.text('ABCDE1234F'), pin: a.text('056000'), m: a.text('123456789'), raw: a.text('12-34') };
    expect(codes(run(def, bad).errors)).toEqual(['pan preset', 'pin preset', 'm mask', 'raw mask']);
    expect(run(def, bad).errors.map((e) => e.message)).toEqual([
      'This value is not in a valid format.', 'This value is not in a valid format.', 'Enter a value in the format shown.', 'Enter a value in the format shown.',
    ]);
  });

  it('checks relative and field date bounds, age and holiday calendars', () => {
    const cal = id<S.HolidayCalendarId>('in_national');
    const def = form(
      [
        field('date', 'start', { config: { pattern: 'DD/MM/YYYY', picker: 'calendar', limits: { min: { kind: 'relative', offset: 0, unit: 'day' }, max: { kind: 'relative', offset: 1, unit: 'month' } } } }),
        field('date', 'end', { config: { pattern: 'DD/MM/YYYY', picker: 'calendar', limits: { min: { kind: 'field', blockId: bid('start'), offsetDays: 1 }, holidayCalendarId: cal } } }),
        field('date', 'dob', { config: { pattern: 'DD/MM/YYYY', picker: 'calendar', limits: { age: { min: 18, max: 60 } } } }),
      ],
      [page('p1', ['start', 'end', 'dob'])],
    );
    const holidays = { [cal]: [id<S.IsoDate>('2026-10-20')] };
    const check = (raw: Record<string, S.AnswerValue>) => codes(run(def, raw, 'submit', { holidayCalendars: holidays }).errors);
    expect(check({ start: a.date('2026-10-18'), end: a.date('2026-10-19'), dob: a.date('2008-10-18') })).toEqual([]);
    expect(check({ start: a.date('2026-10-17') })).toEqual(['start date_out_of_range']);
    expect(check({ start: a.date('2026-11-19') })).toEqual(['start date_out_of_range']);
    expect(check({ start: a.date('2026-10-18'), end: a.date('2026-10-18') })).toEqual(['end date_out_of_range']);
    expect(check({ end: a.date('2026-10-01') })).toEqual([]);
    expect(check({ end: a.date('2026-10-20') })).toEqual(['end date_not_allowed']);
    expect(check({ dob: a.date('2008-10-19') })).toEqual(['dob age_out_of_range']);
    expect(check({ dob: a.date('1965-10-18') })).toEqual(['dob age_out_of_range']);
    expect(check({ dob: a.date('1965-10-19') })).toEqual([]);
  });

  it('rejects options that logic hid, and adds submit blocks in scope', () => {
    const def = form(
      [field('single_choice', 's', { config: { display: 'radio', options: choices('a', 'b') } }), field('multi_choice', 'm', { config: { display: 'checkbox', options: choices('a', 'b') } })],
      [page('p1', ['s']), page('p2', ['m'])],
    );
    const version = versionOf(def);
    const answers = { [bid('s')]: a.single('b'), [bid('m')]: a.multi('a', 'b') };
    const evaluated = evaluate(version, answers, META, 'client');
    const state: S.EvalState = {
      ...evaluated,
      hiddenOptions: { [bid('s')]: [oid('b')], [bid('m')]: [oid('b')] },
      submitBlocks: [
        { ruleId: id<S.RuleId>('r1'), message: 'End date must be after start date', atPage: pid('p2'), anchorBlockId: bid('m') },
        { ruleId: id<S.RuleId>('r2'), message: '' },
      ],
    };
    const validate = (scope: S.PageId | 'submit') =>
      codes(validateAnswers(version, state, answers, { scope: scope === 'submit' ? 'submit' : { page: scope as S.PageId }, locale: EN_IN, today: TODAY }));
    expect(validate(pid('p1'))).toEqual(['s.optionId not_in_options']);
    expect(validate(pid('p2'))).toEqual(['m.optionIds.1 not_in_options', 'm blocked_by_rule']);
    expect(validate('submit')).toEqual(['s.optionId not_in_options', 'm.optionIds.1 not_in_options', 'm blocked_by_rule', '- blocked_by_rule']);
    const messages = validateAnswers(version, state, answers, { scope: 'submit', locale: EN_IN, today: TODAY }).map((e) => e.message);
    expect(messages.slice(-2)).toEqual(['End date must be after start date', 'This answer cannot be accepted.']);
  });

  it('shows a submit block in the locale through its rule:<ruleId>:<actionIndex> translation', () => {
    const HI = id<S.Locale>('hi-IN');
    const base = form([field('short_text', 't')], [page('p1', ['t'])]);
    const block = (message: string): S.ClientAction => ({ type: 'block_submit', message, anchorBlockId: bid('t') });
    const translation = (value: string): S.TranslationEntry => ({ value, sourceHash: id<S.Sha256Hex>('c'.repeat(64)), origin: 'human' });
    const def: S.FormDefinition = {
      ...base,
      logic: { ...base.logic, rules: [rule('r1', cond(ref('t'), 'is_not_answered'), [show('t'), block('Too early')], [block('Too late')])] },
      i18n: {
        ...base.i18n,
        locales: [...base.i18n.locales, { locale: HI, direction: 'ltr' }],
        messages: { [HI]: { 'rule:r1:1': translation('बहुत जल्दी'), 'rule:r1:2': translation('बहुत देर') } },
      },
    };
    const version = { ...versionOf(base), definition: def };
    const state: S.EvalState = {
      ...evaluate(version, {}, META, 'client'),
      submitBlocks: [
        { ruleId: id<S.RuleId>('r1'), message: 'Too early', anchorBlockId: bid('t') },
        { ruleId: id<S.RuleId>('r1'), message: 'Too late', anchorBlockId: bid('t') },
        { ruleId: id<S.RuleId>('r9'), message: 'No rule', anchorBlockId: bid('t') },
      ],
    };
    const messages = (locale: S.Locale) => validateAnswers(version, state, {}, { scope: 'submit', locale, today: TODAY }).map((e) => e.message);
    expect(messages(HI)).toEqual(['बहुत जल्दी', 'बहुत देर', 'No rule']);
    expect(messages(EN_IN)).toEqual(['Too early', 'Too late', 'No rule']);
  });

  it('reports the exclusive option and maxSelected with the right limit', () => {
    const def = form(
      [
        field('multi_choice', 'x', { config: { display: 'checkbox', options: choices('a', 'b', 'none'), exclusiveOptionIds: [oid('none')] } }),
        field('multi_choice', 'y', { config: { display: 'checkbox', options: choices('a', 'b', 'c'), maxSelected: 2 } }),
      ],
      [page('p1', ['x', 'y'])],
    );
    const { errors } = run(def, { x: a.multi('a', 'none'), y: a.multi('a', 'b', 'c') });
    expect(errors.map((e) => e.message)).toEqual(['Select no more than 1 option.', 'Select no more than 2 options.']);
  });
});
