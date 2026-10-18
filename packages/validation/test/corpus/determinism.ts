import { evaluate } from '@form/logic';
import type * as S from '@form/schema';
import { PRESET_SOURCES, compilePattern, matchesMask, matchesPreset, normalizeAnswers, validateAnswers } from '../../src/index.ts';
import { EN_IN, META, a, ans as ref, choices, cond, field, form, id, page, requireIt, rule, show, versionOf } from '../build.ts';
import { TODAY, ans } from '../helpers.ts';

/*
 * The validation leg of the determinism job (schema §3.3.13, VAL-04): the same verdicts in Node, Chromium,
 * Firefox and WebKit. It holds the regex corpus (re2js against `\s` with NBSP and other separators, `\w`
 * and `\b` with Devanagari, the `i` flag with non-ASCII case pairs, `.` with astral and combining
 * characters, Unicode classes), the presets and masks over the same strings, and validateAnswers over a
 * multi-page form with logic, in every scope, for a fixed set of generated answer sets.
 */

export interface CorpusCase { name: string; json: string }

const cp = (...points: number[]) => String.fromCodePoint(...points);

/** Inputs whose meaning differs between regex engines, Unicode versions or naive case mapping. */
export const REGEX_INPUTS: readonly string[] = [
  '', 'a b', `a${cp(0xa0)}b`, `a${cp(0x2007)}b`, `a${cp(0x202f)}b`, `a${cp(0x3000)}b`, `a${cp(0x2028)}b`, `a${cp(0x85)}b`, `a${cp(0x180e)}b`, `a${cp(0xfeff)}b`, 'a\tb', 'a\nb',
  'abc', 'ABC', 'a_1', 'नमस्ते', 'क्षत्रिय', 'हिन्दी भाषा', 'ভাষা', 'தமிழ்', '१२३', '٣', '123', 'x नम', 'café', `cafe${cp(0x301)}`,
  'straße', 'STRASSE', 'STRAẞE', 'ß', 'ẞ', 'Σ', 'σ', 'ς', 'K', cp(0x212a), 'k', 'İ', 'i', 'ı', 'I', 'ǅ', 'ǆ', 'Ǆ', 'Ꭰ', 'ꭰ', cp(0x10400), cp(0x10428),
  'µ', 'μ', 'ﬁ', 'FI', '😀', '👩🏽‍💻', '🇮🇳', cp(0xd800), `${cp(0xd83d)}x`, 'ǰ', 'ΐ', 'Å', 'Å', 'Ⓐ', 'ⓐ',
];

/** [source, flags] pairs: each runs against every input, with its program size; a pattern that does not compile records its failure reason. */
export const REGEX_PATTERNS: ReadonlyArray<readonly [string, '' | 'i']> = [
  ['^a\\sb$', ''], ['\\s', ''], ['^a\\Sb$', ''], ['^[[:space:]]+$', ''], ['\\p{Z}', ''],
  ['^\\w+$', ''], ['^\\W+$', ''], ['\\bनम', ''], ['é\\b', ''], ['\\b', ''], ['^[\\p{L}\\p{M}]+$', ''], ['^\\p{Devanagari}+$', ''], ['^\\pN+$', ''], ['^\\d+$', ''], ['^[[:alpha:]]+$', ''],
  ['^straße$', 'i'], ['^STRASSE$', 'i'], ['^ß$', 'i'], ['^σ$', 'i'], ['^Σ$', 'i'], ['^k$', 'i'], ['^K$', ''], ['^i$', 'i'], ['^ı$', 'i'], ['^ǆ$', 'i'], ['^ꭰ$', 'i'],
  [`^${cp(0x10428)}$`, 'i'], ['^μ$', 'i'], ['^fi$', 'i'], ['^(?i)abc$', ''], ['^café$', 'i'], ['^å$', 'i'],
  ['^.$', ''], ['^..$', ''], ['^.{4}$', ''], ['^\\X$', ''], ['(?s)a.b', ''], ['a.b', ''], ['^a$', ''], ['(?m)^b$', ''],
  ['(a)\\1', ''], ['(?=a)', ''], ['(?<=a)b', ''], ['a{1001}', ''], ['[', ''], ['a'.repeat(257), ''], ['^[^\\x{0}-\\x{7F}]+$', ''],
  /* PATTERN_MAX_PROGRAM: a short source that compiles to a large program is refused, one under the budget runs. */
  ['(?:\\pL|b){1000}'.repeat(16), ''], ['a{1000}', ''], ['^(?:\\pL|b){499}$', ''],
  /* PATTERN_COST_BUDGET: the worst shape under the program cap; its `size`, the budget's input, must agree too. */
  ['(?:[\\pL\\pN]|b){990}$', ''],
];

function regexCases(): CorpusCase[] {
  return REGEX_PATTERNS.map(([source, flags], i) => {
    const compiled = compilePattern({ source, flags });
    const verdicts = compiled.ok ? REGEX_INPUTS.map((input) => (compiled.test(input) ? 1 : 0)).join('') : `invalid:${compiled.reason}`;
    const size = compiled.ok ? compiled.size : null;
    return { name: `regex_${String(i).padStart(2, '0')}`, json: JSON.stringify({ source, flags, size, verdicts }) };
  });
}

function presetCases(): CorpusCase[] {
  const inputs = [...REGEX_INPUTS, 'ABCPE1234F', 'abcpe1234f', '27AAPFU0939F1ZV', '560001', 'SBIN0001234', 'KA 01 AB 1234', '22BH1234AA', '1234', '१२३४'];
  return (Object.keys(PRESET_SOURCES) as S.TextPreset[]).map((preset) => ({
    name: `preset_${preset}`,
    json: JSON.stringify(inputs.map((input) => (matchesPreset(preset, input) ? 1 : 0)).join('')),
  }));
}

function maskCases(): CorpusCase[] {
  const masks: S.InputMask[] = [
    { pattern: '#####-####', storeMasked: true }, { pattern: '@@-##', storeMasked: true }, { pattern: '***', storeMasked: false }, { pattern: '##[ ext ###]', storeMasked: true },
  ];
  const inputs = ['12345-6789', '123456789', 'AB-12', 'अआ-१२', 'कि-12', 'a1Z', 'ñ9ß', '12 ext 345', '12', '12 ext', '😀😀😀'];
  return masks.map((mask, i) => ({ name: `mask_${i}`, json: JSON.stringify(inputs.map((input) => String(matchesMask(mask, input))).join(',')) }));
}

/** A deterministic generator (mulberry32), so every engine draws the same answer sets. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;

function fixtureForm(): S.FormDefinition {
  const blocks: S.StoredBlock[] = [
    field('short_text', 'name', { required: true, config: { maxLength: 12, pattern: { source: '^[\\p{L}\\p{M} ]+$' } } }),
    field('short_text', 'pan', { config: { preset: 'in_pan' } }),
    field('email', 'email', { required: true, messages: { invalid_email: 'Use a work address' } }),
    field('number', 'age', { config: { display: 'input', min: id<S.DecimalString>('0'), max: id<S.DecimalString>('120'), integerOnly: true } }),
    field('short_text', 'guardian', { initiallyHidden: true }),
    field('single_choice', 'plan', { required: true, config: { display: 'radio', options: choices('free', 'pro'), other: { enabled: true, textRequired: true, maxLength: 20 } } }),
    field('multi_choice', 'topics', { config: { display: 'checkbox', options: choices('a', 'b', 'c', 'none'), maxSelected: 2, exclusiveOptionIds: [id<S.OptionId>('none')] } }),
    field('long_text', 'bio', { config: { rows: 4, limit: { unit: 'words', max: 5 } } }),
    field('date', 'dob', { config: { pattern: 'DD/MM/YYYY', picker: 'calendar', limits: { max: { kind: 'relative', offset: 0, unit: 'day' }, age: { min: 13 } } } }),
    field('nps', 'nps', { required: true }),
    field('ranking', 'rank', { required: true, config: { options: choices('x', 'y', 'z') } }),
  ];
  return form(
    blocks,
    [page('p1', ['name', 'pan', 'email']), page('p2', ['age', 'guardian', 'plan', 'topics']), page('p3', ['bio', 'dob', 'nps', 'rank'])],
    [rule('minor', cond(ref('age'), 'lt', { kind: 'literal', value: { type: 'number', value: id<S.DecimalString>('18') } }), [show('guardian'), requireIt('guardian')])],
  );
}

const POOLS: Readonly<Record<string, ReadonlyArray<S.AnswerValue | null>>> = {
  name: [a.text('Asha Rao'), a.text('नमस्ते जी'), a.text(`Asha${cp(0xa0)}Rao`), a.text('R2D2'), a.text('A very long name indeed'), a.text(''), null],
  pan: [a.text('ABCPE1234F'), a.text('abcpe1234f'), a.text(''), null],
  email: [a.email('asha@example.com'), a.email('asha@'), a.email('नाम@उदाहरण.भारत'), null],
  age: [a.number('12'), a.number('40'), a.number('12.5'), a.number('121'), ans.raw('number', ''), ans.raw('number', 'abc'), null],
  guardian: [a.text('Ravi'), a.text(''), null],
  plan: [a.single('free'), a.single(null, 'enterprise'), a.single(null, ''), a.single('gold'), null],
  topics: [a.multi('a'), a.multi('a', 'b', 'c'), a.multi('a', 'none'), a.multi(), null],
  bio: [a.long('one two three'), a.long(`one${cp(0x3000)}two three four five six`), a.long(''), null],
  dob: [a.date('2000-01-01'), a.date('2020-01-01'), a.date('2027-01-01'), a.date('2026-02-30'), null],
  nps: [a.nps(0), a.nps(10), a.nps(11), null],
  rank: [ans.ranking('x', 'y', 'z'), ans.ranking('x'), ans.ranking(), null],
};

const SCOPES: ReadonlyArray<S.PageId | 'submit'> = [id<S.PageId>('p1'), id<S.PageId>('p2'), id<S.PageId>('p3'), 'submit'];
const ANSWER_SETS = 200;

/** validateAnswers in every scope over generated answer sets: codes, paths, params and en-IN messages. */
function validationCases(): CorpusCase[] {
  const version = versionOf(fixtureForm());
  const next = rng(0x5eed);
  const cases: CorpusCase[] = [];
  for (let n = 0; n < ANSWER_SETS; n += 1) {
    const raw: Record<string, S.AnswerValue | null> = {};
    for (const [blockId, pool] of Object.entries(POOLS)) raw[blockId] = pick(next, pool);
    const state = evaluate(version, normalizeAnswers(raw), META, 'client');
    const errors = SCOPES.map((scope) => validateAnswers(version, state, raw, { scope: scope === 'submit' ? 'submit' : { page: scope as S.PageId }, locale: EN_IN, today: TODAY }));
    cases.push({ name: `validate_${String(n).padStart(3, '0')}`, json: JSON.stringify(errors) });
  }
  return cases;
}

export function runCorpus(): CorpusCase[] {
  return [...regexCases(), ...presetCases(), ...maskCases(), ...validationCases()];
}
