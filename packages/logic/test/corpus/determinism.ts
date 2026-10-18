import { graphemes } from '@form/i18n';
import { REGISTRY } from '@form/registry';
import graphemeCorpus from '@form/i18n/test-fixtures/graphemes.json' with { type: 'json' };
import type * as S from '@form/schema';
import { caseFold, compile, evalStateJson, evaluate, textLength } from '../../src/index.ts';
import { META, a, all, ans, bid, cond, field, form, heading, hide, id, meta, num, page, rule, text, versionOf } from '../build.ts';
import { V1_FORMS, rng, v1AnswerSets } from './generate.ts';
import { randomAnswers, randomForm } from './random.ts';
import { toV2, toV2Answers } from './v1.ts';

/*
 * The determinism corpus (schema §3.3.13): the same code runs in Node and, through Playwright, in
 * Chromium, Firefox and WebKit, and every engine's output must be byte-identical. It holds the 35 v1
 * parity fixtures × 200 answer sets, random P0 forms (every operator and action), text and decimal edge
 * cases, and the pinned grapheme segmenter's Indic corpus from @form/i18n.
 */

export interface CorpusCase { name: string; json: string }

/** Strings whose folding, normalisation or segmentation differs between naive implementations and hosts. */
export const TRICKY_TEXT = [
  'straße', 'STRASSE', 'ẞ', 'ß', 'ǅ', 'ǆ', 'Ǆ', 'İstanbul', 'istanbul', 'ı', 'I', 'Σίσυφος', 'ΣΊΣΥΦΟΣ', 'σίσυφοσ', 'ﬁle', 'FILE',
  'Café', 'Café', 'Å', 'Å', 'Ꭰ', 'ꭰ', '\u{10400}', '\u{10428}', 'Ⓐ', 'ⓐ', 'ǰ', 'ΐ', 'K', 'k', 'µ', 'μ', 'ſ', 's',
  'नमस्ते', 'क्षत्रिय', 'ভাষা', 'தமிழ்', 'ଓଡ଼ିଆ', 'മലയാളം', '👩🏽‍💻', '🇮🇳', 'ä́', ' ', '',
];

/** Decimal strings near the edges of `DecimalString` (34 significant digits, 10 decimals). */
export const TRICKY_NUMBERS = [
  '0', '-0', '1', '-1', '0.1', '0.2', '0.3', '0.30', '1.0000000001', '0.0000000001', '9999999999999999999999.9999999999',
  '9999999999999999999999.9999999998', '-9999999999999999999999.9999999999', '9007199254740993', '9007199254740992', '123456789012345678901234',
];

function textForm(): S.FormDefinition {
  const ops: Array<[S.LogicOperator, boolean]> = [['eq', false], ['eq', true], ['contains', false], ['starts_with', false], ['ends_with', false], ['neq', false]];
  const rules: S.Rule[] = [];
  const targets: S.StoredBlock[] = [];
  TRICKY_TEXT.slice(0, 18).forEach((literal, i) => {
    ops.forEach(([op, caseSensitive], j) => {
      const target = `t${i}_${j}`;
      targets.push(heading(target));
      rules.push(rule(`r${i}_${j}`, cond(ans('name'), op, text(literal), caseSensitive ? { caseSensitive } : {}), [hide(target)]));
    });
  });
  return form([field('short_text', 'name'), ...targets], [page('p1', ['name', ...targets.map((t) => t.id)])], rules);
}

function numberForm(): S.FormDefinition {
  const rules: S.Rule[] = [];
  const targets: S.StoredBlock[] = [];
  TRICKY_NUMBERS.forEach((literal, i) => {
    (['eq', 'gt', 'lte'] as const).forEach((op, j) => {
      const target = `n${i}_${j}`;
      targets.push(heading(target));
      rules.push(rule(`q${i}_${j}`, cond(ans('amount'), op, num(literal)), [hide(target)]));
    });
  });
  rules.push(rule('between', cond(ans('amount'), 'between', num('-0.1'), { right2: num('0.1') }), [hide('amount_note')]));
  targets.push(heading('amount_note'));
  return form([field('number', 'amount'), ...targets], [page('p1', ['amount', ...targets.map((t) => t.id)])], rules);
}

function metaForm(): S.FormDefinition {
  return form([
    field('hidden', 'src', { config: { source: { kind: 'url_param', name: 'src' } } }),
    heading('ad'), heading('mobile'), heading('preview'),
  ], [page('p1', ['src', 'ad']), page('p2', ['mobile', 'preview'])], [
    rule('m1', cond(ans('src'), 'starts_with', text('AD')), [hide('ad')]),
    rule('m2', cond(meta('device'), 'eq', text('mobile')), [hide('mobile', 'p2')]),
    rule('m3', all(cond(meta('is_preview'), 'is_true'), cond(meta('utm_source'), 'contains', text('ma'))), [hide('preview')]),
  ]);
}

function run(def: S.FormDefinition, sets: Array<{ answers: S.Answers; meta?: Partial<S.EvalMeta> }>, name: string, trace = false): CorpusCase[] {
  const version = versionOf(def);
  const pages = def.pages.map((p) => p.id);
  return sets.map(({ answers, meta: m }, n) => ({
    name: `${name}#${n}`,
    json: evalStateJson(evaluate(version, answers, { ...META, ...m }, n % 2 ? 'server' : 'client', { trace: trace || n % 10 === 0 }), pages),
  }));
}

export function runCorpus(): CorpusCase[] {
  const cases: CorpusCase[] = [];
  V1_FORMS.forEach((f, i) => {
    const sets = v1AnswerSets(f, 200, 7_000 + i).map((values) => ({ answers: toV2Answers(f, values) }));
    cases.push(...run(toV2(f), sets, f.name));
  });
  cases.push(...run(textForm(), TRICKY_TEXT.filter((t) => t !== '').map((t) => ({ answers: { [bid('name')]: a.text(t) } })), 'text', true));
  cases.push(...run(numberForm(), TRICKY_NUMBERS.map((v) => ({ answers: { [bid('amount')]: a.number(v) } })), 'numbers', true));
  const r = rng(42);
  cases.push(...run(metaForm(), Array.from({ length: 24 }, () => ({
    answers: r.chance(0.3) ? { [bid('src')]: a.hidden('kept') } : {},
    meta: {
      urlParams: r.chance(0.5) ? { src: r.pick(['ad-1', 'Ad', 'organic']), utm_source: r.pick(['mail', 'sms']) } : {},
      ...(r.chance(0.5) ? { device: r.pick(['mobile', 'desktop'] as const) } : {}),
      isPreview: r.chance(0.5),
      locale: id<S.Locale>(r.pick(['en-IN', 'hi-IN'])),
    },
  })), 'meta', true));
  for (let i = 0; i < 20; i += 1) {
    const def = randomForm(900 + i);
    if (!compile(def, REGISTRY).ok) continue;
    const rr = rng(9_000 + i);
    cases.push(...run(def, Array.from({ length: 20 }, () => ({ answers: randomAnswers(rr, def), meta: { urlParams: rr.chance(0.5) ? { src: 'ad' } : {} } })), `random_${i + 1}`));
  }
  cases.push({ name: 'caseFold', json: JSON.stringify(TRICKY_TEXT.map((t) => [caseFold(t), textLength(t)])) });
  return cases;
}

/** BL-011: the @form/i18n grapheme corpus, segmented by the pinned segmenter in this engine. */
export function runGraphemes(): Array<{ text: string; expected: string[]; actual: string[] }> {
  return (graphemeCorpus as Array<{ text: string; graphemes: string[] }>).map((entry) => ({ text: entry.text, expected: entry.graphemes, actual: graphemes(entry.text) }));
}
