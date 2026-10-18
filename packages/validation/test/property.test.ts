import { evaluate } from '@form/logic';
import type * as S from '@form/schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeAnswers, validateAnswers } from '../src/index.ts';
import { EN_IN, META, a, ans as ref, choices, cond, disable, enable, field, form, hide, num, opts, page, pid, requireIt, rule, show, text, unrequire, versionOf } from './build.ts';
import { TODAY, ans } from './helpers.ts';

/*
 * Property (WP-0.09 acceptance): no error outside visible_eff or the current page. Also, Submit on the
 * complete answers reports exactly the block errors that Next reported on each page of the path when only
 * that page and the ones before it were answered (I8: rules read earlier blocks only), so a respondent who
 * passed every page cannot fail at Submit.
 */

type Kind = 'short_text' | 'number' | 'single_choice' | 'multi_choice' | 'email' | 'nps' | 'ranking';
const KINDS: readonly Kind[] = ['short_text', 'number', 'single_choice', 'multi_choice', 'email', 'nps', 'ranking'];

function block(kind: Kind, blockId: string, required: boolean, hidden: boolean): S.FieldBlock {
  const extra = { required, ...(hidden ? { initiallyHidden: true } : {}) };
  switch (kind) {
    case 'short_text':
      return field('short_text', blockId, { ...extra, config: { maxLength: 4, pattern: { source: '^[a-z]*$' } } });
    case 'number':
      return field('number', blockId, { ...extra, config: { display: 'input', max: '10' as S.DecimalString } });
    case 'single_choice':
      return field('single_choice', blockId, { ...extra, config: { display: 'radio', options: choices('a', 'b') } });
    case 'multi_choice':
      return field('multi_choice', blockId, { ...extra, config: { display: 'checkbox', options: choices('a', 'b', 'c'), maxSelected: 2 } });
    case 'email':
      return field('email', blockId, extra);
    case 'nps':
      return field('nps', blockId, extra);
    case 'ranking':
      return field('ranking', blockId, { ...extra, config: { options: choices('a', 'b') } });
  }
}

/** Valid, invalid and blank control values per kind. */
const VALUES: Record<Kind, Array<S.AnswerValue | null>> = {
  short_text: [a.text('ab'), a.text('ABCDE'), a.text(''), null],
  number: [a.number('3'), a.number('11'), ans.raw('number', 'x'), ans.raw('number', '')],
  single_choice: [a.single('a'), a.single('zz'), a.single(null), null],
  multi_choice: [a.multi('a'), a.multi('a', 'b', 'c'), a.multi(), null],
  email: [a.email('x@y.co'), a.email('bad'), ans.raw('email', { address: '' }), null],
  nps: [a.nps(0), a.nps(11), null],
  ranking: [ans.ranking('a', 'b'), ans.ranking('a'), ans.ranking(), null],
};

const conditionFor = (kind: Kind, source: string, variant: number): S.Condition => {
  switch (kind) {
    case 'number':
    case 'nps':
      return cond(ref(source), variant % 2 ? 'gt' : 'lte', num('5'));
    case 'single_choice':
    case 'multi_choice':
      return cond(ref(source), 'includes_any', opts(source, 'a'));
    case 'short_text':
      return cond(ref(source), variant % 2 ? 'eq' : 'neq', text('ab'));
    default:
      return cond(ref(source), variant % 2 ? 'is_answered' : 'is_not_answered');
  }
};

const ACTIONS = [show, hide, requireIt, unrequire, enable, disable] as const;

interface Scenario {
  fields: Array<{ kind: Kind; required: boolean; hidden: boolean; pageBreak: boolean }>;
  rules: Array<{ source: number; target: number; action: number; variant: number; elseAction: number | null }>;
  hidePage: number | null;
  answers: number[];
}

const scenario: fc.Arbitrary<Scenario> = fc.record({
  fields: fc.array(fc.record({ kind: fc.constantFrom(...KINDS), required: fc.boolean(), hidden: fc.boolean(), pageBreak: fc.boolean() }), { minLength: 1, maxLength: 9 }),
  rules: fc.array(fc.record({ source: fc.nat(), target: fc.nat(), action: fc.nat({ max: ACTIONS.length - 1 }), variant: fc.nat(3), elseAction: fc.option(fc.nat({ max: ACTIONS.length - 1 })) }), { maxLength: 8 }),
  hidePage: fc.option(fc.nat()),
  answers: fc.array(fc.nat(), { minLength: 9, maxLength: 9 }),
});

function build(s: Scenario): { def: S.FormDefinition; raw: Record<string, S.AnswerValue | null> } {
  const blocks = s.fields.map((f, i) => block(f.kind, `f${i}`, f.required, f.hidden));
  const pages: S.Page[] = [];
  let current: string[] = [];
  s.fields.forEach((f, i) => {
    if (f.pageBreak && current.length) {
      pages.push(page(`p${pages.length + 1}`, current));
      current = [];
    }
    current.push(`f${i}`);
  });
  pages.push(page(`p${pages.length + 1}`, current));
  if (s.hidePage !== null && pages.length > 1) {
    const at = 1 + (s.hidePage % (pages.length - 1));
    pages[at] = { ...(pages[at] as S.Page), initiallyHidden: true };
  }
  /* I8: a rule only reads a block earlier in the document than its target, so never a later page. */
  const rules = s.rules.flatMap((r, i) => {
    if (s.fields.length < 2) return [];
    const target = 1 + (r.target % (s.fields.length - 1));
    const source = r.source % target;
    const kind = s.fields[source]?.kind ?? 'short_text';
    const act = ACTIONS[r.action] ?? show;
    const otherwise = r.elseAction === null ? undefined : [(ACTIONS[r.elseAction] ?? hide)(`f${target}`)];
    return [rule(`r${i}`, conditionFor(kind, `f${source}`, r.variant), [act(`f${target}`)], otherwise)];
  });
  const raw: Record<string, S.AnswerValue | null> = {};
  s.fields.forEach((f, i) => {
    const pool = VALUES[f.kind];
    raw[`f${i}`] = pool[(s.answers[i] ?? 0) % pool.length] ?? null;
  });
  return { def: form(blocks, pages, rules), raw };
}

describe('validation scope (property)', () => {
  it('never reports an error outside visible_eff or the current page, and Submit = Next over the path', () => {
    let withErrors = 0;
    let hiddenRequired = 0;
    let passedEveryPage = 0;
    fc.assert(
      fc.property(scenario, (s) => {
        const { def, raw } = build(s);
        const version = versionOf(def);
        const key = (e: S.FieldError) => `${e.blockId ?? ''} ${e.path ?? ''} ${e.code}`;
        const state = evaluate(version, normalizeAnswers(raw), META, 'client');
        const onPages: string[] = [];
        /* Next on page P sees only the answers a respondent has given by then: the blocks of P and the pages before it. */
        const seen = new Set<string>();
        for (const p of def.pages) {
          for (const child of p.children) seen.add(child);
          const sofar = Object.fromEntries(Object.entries(raw).filter(([blockId]) => seen.has(blockId)));
          const then = evaluate(version, normalizeAnswers(sofar), META, 'client');
          expect(then.path.includes(p.id), p.id).toBe(state.path.includes(p.id));
          for (const e of validateAnswers(version, then, sofar, { scope: { page: p.id }, locale: EN_IN, today: TODAY })) {
            const blockId = e.blockId as S.BlockId;
            expect(then.visible.has(blockId), key(e)).toBe(true);
            expect(then.disabled.has(blockId), key(e)).toBe(false);
            expect(version.compiled.pageOf[blockId], key(e)).toBe(p.id);
            expect(then.path).toContain(p.id);
            onPages.push(key(e));
          }
        }
        const submit = validateAnswers(version, state, raw, { scope: 'submit', locale: EN_IN, today: TODAY });
        if (submit.length) withErrors += 1;
        else passedEveryPage += 1;
        if (def.pages.some((p) => p.children.some((c) => !state.visible.has(c) && def.blocks[c]?.type !== undefined && (def.blocks[c] as S.FieldBlock).required))) hiddenRequired += 1;
        for (const e of submit) expect(state.visible.has(e.blockId as S.BlockId), key(e)).toBe(true);
        expect(submit.map(key).sort()).toEqual(onPages.sort());
        for (const id of state.required) {
          if (normalizeAnswers(raw)[id] === undefined) expect(submit.map(key)).toContain(`${id}  required`);
        }
      }),
      { numRuns: 300, seed: 9 },
    );
    expect(withErrors).toBeGreaterThan(100);
    expect(passedEveryPage).toBeGreaterThan(10);
    expect(hiddenRequired).toBeGreaterThan(30);
  });

  it('never throws on arbitrary answer values', () => {
    const def = form(KINDS.map((k, i) => block(k, `f${i}`, i % 2 === 0, false)), [page('p1', KINDS.map((_, i) => `f${i}`))]);
    const version = versionOf(def);
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.constantFrom(...KINDS), fc.anything()), { minLength: KINDS.length, maxLength: KINDS.length }), (values) => {
        const raw = Object.fromEntries(values.map(([type, value], i) => [`f${i}`, ans.raw(type, value)]));
        const answers = normalizeAnswers(raw);
        const state = evaluate(version, answers, META, 'client');
        const errors = validateAnswers(version, state, raw, { scope: { page: pid('p1') }, locale: EN_IN, today: TODAY });
        for (const e of errors) expect(e.message).not.toMatch(/^system:/);
      }),
      { numRuns: 300, seed: 11 },
    );
  });
});
