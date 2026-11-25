import { REGISTRY } from '@form/registry';
import { FormDefinitionSchema, sha256Jcs } from '@form/schema';
import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import {
  applicableUnits, compile, evaluate, reviewUnitAnswersHash, reviewUnitIssues, reviewUnitMembership, validateDefinition, visibleBlocksForReviewer,
} from '../src/index.ts';
import { META, a, ans, bid, cond, field, form, heading, hide, id, num, oid, page, rule, text, versionOf } from './build.ts';
import { V1_FORMS } from './corpus/generate.ts';
import { toV2 } from './corpus/v1.ts';
import { REVIEW_ASSIGNMENTS, assign, breakTarget, groups, pageTarget, reviewCases, reviewForm, reviewUnit, sectionBreak, sectionOf } from './corpus/review.ts';

/* WP-2.33: review units in the definition: membership, publish checks, compile, the answers hash, applicability and redaction. */

const uid = (v: string) => id<S.ReviewUnitId>(v);
const codes = (issues: readonly S.PublishIssue[]) => issues.map((i) => `${i.severity}:${i.code}:${i.path}`);
const reviewCodes = (issues: readonly S.PublishIssue[]) => codes(issues.filter((i) => i.code.startsWith('review_unit_') || (i.code === 'duplicate_id' && i.path.startsWith('/review'))));
const withUnits = (def: S.FormDefinition, ...units: S.ReviewUnit[]): S.FormDefinition => ({ ...def, review: { units } });

/** Two pages: p1 holds a name and a section with two fields; p2 holds an email. */
const twoPages = () => form([
  field('short_text', 'name'),
  sectionOf('box', ['age', 'note']),
  field('number', 'age'),
  heading('note'),
  field('email', 'email'),
], [page('p1', ['name', 'box']), page('p2', ['email'])]);

describe('reviewUnitMembership', () => {
  it('a page unit holds exactly that page\'s blocks, nested children included, in document order', () => {
    const def = withUnits(twoPages(), reviewUnit('u1', pageTarget('p1')), reviewUnit('u2', pageTarget('p2')));
    expect(reviewUnitMembership(def)).toEqual({ u1: ['name', 'box', 'age', 'note'], u2: ['email'] });
  });

  it('a section_break unit runs from the break to the next break, across pages, and the last one to the end', () => {
    const def = reviewForm();
    expect(reviewUnitMembership(def)).toEqual({
      u_applicant: ['brk_a', 'applicant', 'has_bank', 'address'],
      u_contact: ['brk_b', 'contact', 'email', 'phone'],
      u_bank: ['brk_c', 'bank', 'ifsc'],
    });
    const last = withUnits(def, reviewUnit('tail', breakTarget('brk_c')));
    expect(reviewUnitMembership(last)['tail' as S.ReviewUnitId]).toEqual(['brk_c', 'bank', 'ifsc']);
    /* The block before the first break belongs to no unit. */
    expect(Object.values(reviewUnitMembership(def)).flat()).not.toContain('intro');
  });

  it('a break inside a section container closes the unit before it in document order', () => {
    const def = withUnits(form([
      field('short_text', 'a'), sectionBreak('b1'), field('short_text', 'b'),
      sectionOf('box', ['b2', 'c']), sectionBreak('b2'), field('short_text', 'c'), field('short_text', 'd'),
    ], [page('p1', ['a', 'b1', 'b', 'box', 'd'])]), reviewUnit('u1', breakTarget('b1')), reviewUnit('u2', breakTarget('b2')));
    expect(reviewUnitMembership(def)).toEqual({ u1: ['b1', 'b', 'box'], u2: ['b2', 'c', 'd'] });
  });

  it('a unit whose target is missing holds nothing, and a repeated unit id keeps its first membership', () => {
    const def = withUnits(twoPages(), reviewUnit('gone', pageTarget('nope')), reviewUnit('plain', breakTarget('name')), reviewUnit('u1', pageTarget('p2')), reviewUnit('u1', pageTarget('p1')));
    expect(reviewUnitMembership(def)).toEqual({ gone: [], plain: [], u1: ['email'] });
    expect(reviewUnitMembership(twoPages())).toEqual({});
  });
});

describe('reviewUnitIssues and validateDefinition', () => {
  const paymentForm = () => withUnits(form([field('short_text', 'name'), field('payment', 'pay')], [page('p1', ['name']), page('p2', ['pay'])]), reviewUnit('u_pay', pageTarget('p2')), reviewUnit('u_name', pageTarget('p1')));

  it('a clean form has no review issues', () => {
    expect(reviewUnitIssues(reviewForm(), 'publish')).toEqual([]);
    expect(reviewUnitIssues(twoPages(), 'publish')).toEqual([]);
    expect(reviewUnitIssues(withUnits(twoPages()), 'publish')).toEqual([]);
  });

  it('review_unit_dangling_target: a page that is not in the form, a block that is missing, not a break, or not placed', () => {
    const def = withUnits(
      form([field('short_text', 'name'), sectionBreak('orphan')], [page('p1', ['name'])]),
      reviewUnit('u1', pageTarget('nope')), reviewUnit('u2', breakTarget('ghost')), reviewUnit('u3', breakTarget('name')), reviewUnit('u4', breakTarget('orphan')),
    );
    expect(reviewCodes(reviewUnitIssues(def, 'publish'))).toEqual([
      'error:review_unit_dangling_target:/review/units/0/target/pageId',
      'error:review_unit_dangling_target:/review/units/1/target/blockId',
      'error:review_unit_dangling_target:/review/units/2/target/blockId',
      'error:review_unit_dangling_target:/review/units/3/target/blockId',
    ]);
    const messages = reviewUnitIssues(def, 'publish').map((i) => i.message);
    expect(messages[1]).toMatch(/does not exist/);
    expect(messages[2]).toMatch(/is not a section break/);
    expect(messages[3]).toMatch(/is not placed on any page/);
  });

  it('review_unit_empty: an empty page, or a break with nothing after it before the next break', () => {
    const def = withUnits(
      form([field('short_text', 'name'), sectionBreak('b1'), sectionBreak('b2'), field('short_text', 'x')], [page('p1', ['name', 'b1', 'b2', 'x']), page('p2', [])]),
      reviewUnit('u_page', pageTarget('p2')), reviewUnit('u_alone', breakTarget('b1')), reviewUnit('u_full', breakTarget('b2')),
    );
    expect(reviewCodes(reviewUnitIssues(def, 'publish'))).toEqual([
      'error:review_unit_empty:/review/units/0/target',
      'error:review_unit_empty:/review/units/1/target',
    ]);
  });

  it('review_unit_overlap: two units that share a block, whatever the targets are', () => {
    const def = withUnits(reviewForm(), reviewUnit('u_p1', pageTarget('p1')), reviewUnit('u_dup', pageTarget('p1')));
    const overlap = reviewUnitIssues(def, 'publish').filter((i) => i.code === 'review_unit_overlap');
    expect(overlap.map((i) => i.path)).toEqual(['/review/units/0/target', '/review/units/1/target']);
    expect(overlap[0]?.message).toMatch(/'u_p1' and unit 'u_dup' both hold block 'intro'/);
    /* A page unit against a break unit that runs into the page. */
    const mixed = withUnits(reviewForm(), reviewUnit('by_break', breakTarget('brk_a')), reviewUnit('by_page', pageTarget('p2')));
    expect(reviewCodes(reviewUnitIssues(mixed, 'publish'))).toEqual(['error:review_unit_overlap:/review/units/0/target', 'error:review_unit_overlap:/review/units/1/target']);
    /* The same break twice. */
    expect(reviewUnitIssues(withUnits(reviewForm(), reviewUnit('x', breakTarget('brk_b')), reviewUnit('y', breakTarget('brk_b'))), 'publish').map((i) => i.code)).toEqual(['review_unit_overlap', 'review_unit_overlap']);
  });

  it('review_unit_contains_payment: a payment block anywhere in the unit, nested ones too', () => {
    expect(reviewCodes(reviewUnitIssues(paymentForm(), 'publish'))).toEqual(['error:review_unit_contains_payment:/review/units/0/target']);
    const nested = withUnits(form([sectionOf('box', ['pay']), field('payment', 'pay')], [page('p1', ['box'])]), reviewUnit('u1', pageTarget('p1')));
    expect(reviewUnitIssues(nested, 'publish').map((i) => i.code)).toEqual(['review_unit_contains_payment']);
  });

  it('duplicate_id: a unit id used twice flags the later unit only', () => {
    const def = withUnits(twoPages(), reviewUnit('u1', pageTarget('p1')), reviewUnit('u1', pageTarget('p2')));
    expect(reviewCodes(reviewUnitIssues(def, 'publish'))).toEqual(['error:duplicate_id:/review/units/1/id']);
  });

  it('publish reports them as errors and save as warnings, both through validateDefinition', () => {
    const def = withUnits(paymentForm(), reviewUnit('u_bad', pageTarget('nope')));
    const publish = reviewCodes(validateDefinition(def, 'publish', REGISTRY));
    const save = reviewCodes(validateDefinition(def, 'save', REGISTRY));
    expect(publish).toEqual(['error:review_unit_dangling_target:/review/units/0/target/pageId']);
    expect(save).toEqual(['warning:review_unit_dangling_target:/review/units/0/target/pageId']);
    for (const [bad, code] of [[paymentForm(), 'review_unit_contains_payment'], [withUnits(reviewForm(), reviewUnit('a', pageTarget('p1')), reviewUnit('b', pageTarget('p1'))), 'review_unit_overlap']] as const) {
      expect(validateDefinition(bad, 'publish', REGISTRY).filter((i) => i.code === code).every((i) => i.severity === 'error')).toBe(true);
      expect(validateDefinition(bad, 'save', REGISTRY).filter((i) => i.code === code).every((i) => i.severity === 'warning')).toBe(true);
    }
    const empty = withUnits(form([field('short_text', 'name')], [page('p1', ['name']), page('p2', [])]), reviewUnit('u1', pageTarget('p2')));
    expect(reviewCodes(validateDefinition(empty, 'publish', REGISTRY))).toEqual(['error:review_unit_empty:/review/units/0/target']);
    expect(reviewCodes(validateDefinition(empty, 'save', REGISTRY))).toEqual(['warning:review_unit_empty:/review/units/0/target']);
  });
});

describe('compile and review units', () => {
  it('fills compiled.reviewUnits with every valid unit and its blocks', () => {
    const result = compile(reviewForm(), REGISTRY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.compiled.reviewUnits).toEqual({
        u_applicant: ['brk_a', 'applicant', 'has_bank', 'address'],
        u_contact: ['brk_b', 'contact', 'email', 'phone'],
        u_bank: ['brk_c', 'bank', 'ifsc'],
      });
      const every = Object.values(result.compiled.reviewUnits ?? {}).flatMap((blocks) => blocks ?? []);
      expect(every.every((b) => result.compiled.documentOrder.includes(b))).toBe(true);
    }
  });

  it('still returns ok for a draft with an invalid unit, and leaves that unit out', () => {
    const def = withUnits(
      reviewForm(),
      reviewUnit('good', pageTarget('p3')), reviewUnit('dangling', pageTarget('nope')), reviewUnit('overlap_1', breakTarget('brk_a')), reviewUnit('overlap_2', pageTarget('p2')),
    );
    const result = compile(def, REGISTRY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.compiled.reviewUnits ?? {})).toEqual(['good']);
    expect(reviewCodes(validateDefinition(def, 'save', REGISTRY)).every((c) => c.startsWith('warning:'))).toBe(true);
    expect(reviewCodes(validateDefinition(def, 'publish', REGISTRY)).every((c) => c.startsWith('error:'))).toBe(true);
  });

  it('keeps an empty reviewUnits when every unit is dropped, and no key at all without a review', () => {
    const none = compile(withUnits(reviewForm(), reviewUnit('dangling', pageTarget('nope'))), REGISTRY);
    expect(none.ok && none.compiled.reviewUnits).toEqual({});
    const plain = compile(twoPages(), REGISTRY);
    expect(plain.ok && 'reviewUnits' in plain.compiled).toBe(false);
    expect(plain.ok && Object.keys(plain.compiled).sort()).toEqual(
      ['definitionHash', 'dataInventory', 'documentOrder', 'engine', 'pageOf', 'parentOf', 'plan', 'reads', 'requires', 'taint'].sort(),
    );
  });

  it('is deterministic: compiling twice gives the same bytes, and the definition hash covers the review', () => {
    const def = reviewForm();
    const first = compile(def, REGISTRY);
    const second = compile(structuredClone(def), REGISTRY);
    expect(first).toEqual(second);
    const renamed = compile(withUnits(def, ...(def.review?.units ?? []).map((u) => ({ ...u, name: `${String(u.name)} v2` }))), REGISTRY);
    expect(first.ok && renamed.ok && first.compiled.definitionHash !== renamed.compiled.definitionHash).toBe(true);
  });

  it('refuses a payment inside a unit at compile too (payment is not available yet), with the review issue in publish', () => {
    const def = withUnits(form([field('payment', 'pay')], [page('p1', ['pay'])]), reviewUnit('u1', pageTarget('p1')));
    expect(compile(def, REGISTRY).ok).toBe(false);
    expect(validateDefinition(def, 'publish', REGISTRY).map((i) => i.code)).toContain('review_unit_contains_payment');
  });
});

describe('reviewUnitAnswersHash', () => {
  const version = versionOf(reviewForm());
  const { compiled } = version;
  const hash = (answers: S.Answers, unit = 'u_applicant') => reviewUnitAnswersHash(compiled, uid(unit), answers);
  const base = { applicant: a.text('Asha'), has_bank: a.single('yes'), address: a.long('12 Park Road'), email: a.email('a@example.com'), bank: a.text('HDFC') } as unknown as S.Answers;

  it('is the sha256 of the canonical JSON of the unit\'s answers, keyed by block id', () => {
    const expected = sha256Jcs({ applicant: a.text('Asha'), has_bank: a.single('yes'), address: a.long('12 Park Road') });
    expect(hash(base)).toBe(expected);
    expect(hash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable under key order, at the top level and inside an answer', () => {
    const reordered = { bank: base[bid('bank')], address: base[bid('address')], has_bank: { value: { optionId: 'yes' }, type: 'single_choice' }, applicant: { value: 'Asha', type: 'short_text' } } as unknown as S.Answers;
    expect(Object.keys(reordered)[0]).toBe('bank');
    expect(hash(reordered)).toBe(hash(base));
  });

  it('changes when an answer inside the unit changes and not when one outside it changes', () => {
    const before = hash(base);
    expect(hash({ ...base, address: a.long('13 Park Road') } as S.Answers)).not.toBe(before);
    expect(hash({ ...base, applicant: a.text('Asha K') } as S.Answers)).not.toBe(before);
    expect(hash({ ...base, bank: a.text('SBI'), email: a.email('b@example.com') } as S.Answers)).toBe(before);
    expect(hash({ ...base, bank: a.text('SBI') } as S.Answers, 'u_contact')).toBe(hash(base, 'u_contact'));
    expect(hash(base, 'u_contact')).not.toBe(hash({ ...base, email: a.email('b@example.com') } as S.Answers, 'u_contact'));
  });

  it('treats an unanswered block as absent (I9), so an undefined value is the same as no key', () => {
    const without = { applicant: base[bid('applicant')] } as S.Answers;
    expect(hash({ ...without, address: undefined } as unknown as S.Answers)).toBe(hash(without));
    expect(hash({} as S.Answers)).toBe(sha256Jcs({}));
  });

  it('is null for a unit the compiled form does not hold, and never reads a prototype member', () => {
    expect(hash(base, 'nope')).toBeNull();
    expect(hash(base, 'toString')).toBeNull();
    expect(reviewUnitAnswersHash({}, uid('u_applicant'), base)).toBeNull();
  });

  it('hashes the answers the engine kept: an answer hidden by logic does not count', () => {
    const skip = { ...base, applicant: a.text('skip') } as S.Answers;
    const hidden = evaluate(version, skip, META, 'server');
    expect(hash(hidden.values, 'u_contact')).toBe(sha256Jcs({}));
    expect(hash(hidden.values, 'u_applicant')).not.toBe(hash(skip, 'u_applicant'));
  });
});

describe('applicableUnits', () => {
  const version = versionOf(reviewForm());
  const state = (answers: Record<string, S.AnswerValue>) => evaluate(version, answers as S.Answers, META, 'server');
  const result = (answers: Record<string, S.AnswerValue>) => applicableUnits(version.compiled, state(answers)).map((u) => `${u.unitId}:${u.state}`);

  it('lists every unit, applicable when something in it is shown, sorted by unit id', () => {
    expect(result({})).toEqual(['u_applicant:applicable', 'u_bank:applicable', 'u_contact:applicable']);
  });

  it('marks a unit not_applicable when its page is hidden (off the path)', () => {
    expect(result({ applicant: a.text('skip') })).toEqual(['u_applicant:applicable', 'u_bank:applicable', 'u_contact:not_applicable']);
    expect(result({ has_bank: a.single('no') })).toEqual(['u_applicant:applicable', 'u_bank:not_applicable', 'u_contact:applicable']);
    expect(result({ applicant: a.text('skip'), has_bank: a.single('no') })).toEqual(['u_applicant:applicable', 'u_bank:not_applicable', 'u_contact:not_applicable']);
  });

  it('marks a page unit not_applicable when every block of the page is hidden one by one', () => {
    const def = withUnits(form([
      field('short_text', 'name'), field('short_text', 'x'), field('short_text', 'y'),
    ], [page('p1', ['name']), page('p2', ['x', 'y'])], [rule('r', cond(ans('name'), 'eq', text('hide')), [hide('x', 'y')])]), reviewUnit('u2', pageTarget('p2')), reviewUnit('u1', pageTarget('p1')));
    const v = versionOf(def);
    const states = (name: string) => applicableUnits(v.compiled, evaluate(v, { name: a.text(name) } as unknown as S.Answers, META, 'server'));
    expect(states('show')).toEqual([{ unitId: 'u1', state: 'applicable' }, { unitId: 'u2', state: 'applicable' }]);
    expect(states('hide')).toEqual([{ unitId: 'u1', state: 'applicable' }, { unitId: 'u2', state: 'not_applicable' }]);
  });

  describe('the section_break that opens a unit is not something to review', () => {
    /** u1 = brk, x, y (page unit u_page for the control); a rule hides x and y but never the break. */
    const breakForm = () => withUnits(form([
      field('short_text', 'name'), sectionBreak('brk'), field('short_text', 'x'), field('short_text', 'y'),
    ], [page('p1', ['name', 'brk', 'x', 'y'])], [rule('r', cond(ans('name'), 'eq', text('hide')), [hide('x', 'y')])]), reviewUnit('u1', breakTarget('brk')));
    const run = (def: S.FormDefinition, answers: Record<string, S.AnswerValue>) => {
      const v = versionOf(def);
      return { state: evaluate(v, answers as S.Answers, META, 'server'), compiled: v.compiled };
    };

    it('is not_applicable when the break is shown but every field after it is hidden', () => {
      const { state, compiled } = run(breakForm(), { name: a.text('hide') });
      expect(state.visible.has(bid('brk'))).toBe(true);
      expect(state.visible.has(bid('x'))).toBe(false);
      expect(applicableUnits(compiled, state)).toEqual([{ unitId: 'u1', state: 'not_applicable' }]);
    });

    it('stays applicable while one field of the unit is shown', () => {
      const { state, compiled } = run(breakForm(), { name: a.text('show') });
      expect(applicableUnits(compiled, state)).toEqual([{ unitId: 'u1', state: 'applicable' }]);
      const partly = withUnits(form([
        field('short_text', 'name'), sectionBreak('brk'), field('short_text', 'x'), field('short_text', 'y'),
      ], [page('p1', ['name', 'brk', 'x', 'y'])], [rule('r', cond(ans('name'), 'eq', text('hide')), [hide('x')])]), reviewUnit('u1', breakTarget('brk')));
      const half = run(partly, { name: a.text('hide') });
      expect(applicableUnits(half.compiled, half.state)).toEqual([{ unitId: 'u1', state: 'applicable' }]);
    });

    it('is not_applicable when the whole page of the unit is hidden, break included', () => {
      const def = withUnits(form([
        field('short_text', 'name'), sectionBreak('brk'), field('short_text', 'x'),
      ], [page('p1', ['name']), page('p2', ['brk', 'x'])], [rule('r', cond(ans('name'), 'eq', text('hide')), [hide('p2')])]), reviewUnit('u1', breakTarget('brk')));
      const { state, compiled } = run(def, { name: a.text('hide') });
      expect(applicableUnits(compiled, state)).toEqual([{ unitId: 'u1', state: 'not_applicable' }]);
    });

    it('compile records each break that opens a unit, and no marker for a page unit', () => {
      const result = compile(reviewForm(), REGISTRY);
      expect(result.ok && result.compiled.reviewUnitMarkers).toEqual({ u_applicant: 'brk_a', u_contact: 'brk_b' });
      const page = compile(withUnits(twoPages(), reviewUnit('u1', pageTarget('p1'))), REGISTRY);
      expect(page.ok && page.compiled.reviewUnitMarkers).toEqual({});
      const dropped = compile(withUnits(reviewForm(), reviewUnit('o1', breakTarget('brk_a')), reviewUnit('o2', pageTarget('p1')), reviewUnit('dangling', breakTarget('ghost')), reviewUnit('kept', breakTarget('brk_c'))), REGISTRY);
      expect(dropped.ok && dropped.compiled.reviewUnitMarkers).toEqual({ kept: 'brk_c' });
      const plain = compile(twoPages(), REGISTRY);
      expect(plain.ok && 'reviewUnitMarkers' in plain.compiled).toBe(false);
    });

    it('a page unit that holds a break counts it like any block, and a compiled form without markers still works', () => {
      const def = withUnits(form([
        field('short_text', 'name'), sectionBreak('brk'), field('short_text', 'x'),
      ], [page('p1', ['name', 'brk', 'x'])], [rule('r', cond(ans('name'), 'eq', text('hide')), [hide('x')])]), reviewUnit('u1', pageTarget('p1')));
      const { state, compiled } = run(def, { name: a.text('hide') });
      expect(applicableUnits(compiled, state)).toEqual([{ unitId: 'u1', state: 'applicable' }]);
      const old = run(breakForm(), { name: a.text('hide') });
      const { reviewUnitMarkers: _markers, ...withoutMarkers } = old.compiled;
      expect(applicableUnits(withoutMarkers, old.state)).toEqual([{ unitId: 'u1', state: 'applicable' }]);
    });
  });

  it('is applicable when one block of the unit is still shown, and is empty for a form without review', () => {
    const def = withUnits(form([
      field('short_text', 'name'), field('short_text', 'x'), field('short_text', 'y'),
    ], [page('p1', ['name', 'x', 'y'])], [rule('r', cond(ans('name'), 'eq', text('hide')), [hide('x')])]), reviewUnit('u1', pageTarget('p1')));
    const v = versionOf(def);
    expect(applicableUnits(v.compiled, evaluate(v, { name: a.text('hide') } as unknown as S.Answers, META, 'server'))).toEqual([{ unitId: 'u1', state: 'applicable' }]);
    const plain = versionOf(twoPages());
    expect(applicableUnits(plain.compiled, evaluate(plain, {}, META, 'server'))).toEqual([]);
  });
});

describe('visibleBlocksForReviewer', () => {
  const { compiled } = versionOf(reviewForm());
  const settings = { units: REVIEW_ASSIGNMENTS };
  const seen = (...g: string[]) => {
    const set = visibleBlocksForReviewer(compiled, settings, groups(...g));
    return set === null ? null : [...set];
  };
  const APPLICANT = ['brk_a', 'applicant', 'has_bank', 'address'];
  const CONTACT = ['brk_b', 'contact', 'email', 'phone'];
  const BANK = ['brk_c', 'bank', 'ifsc'];

  it('returns null (no redaction) for a caller in no review group', () => {
    expect(seen()).toBeNull();
    expect(seen('g_unrelated')).toBeNull();
    expect(visibleBlocksForReviewer(compiled, { units: [] }, groups('g_applicant'))).toBeNull();
  });

  it('a checker of one own_unit unit sees that unit and the blocks outside all units, and no other unit', () => {
    expect(seen('g_bank')).toEqual(['intro', ...BANK]);
    expect(seen('g_applicant')).toEqual(['intro', ...APPLICANT]);
    expect(seen('g_bank')).not.toContain('applicant');
    expect(seen('g_bank')).not.toContain('email');
  });

  it('whole_submission units never redact', () => {
    expect(seen('g_contact')).toBeNull();
    expect(visibleBlocksForReviewer(compiled, { units: [assign('u_applicant', 'g1', 1, 'whole_submission'), assign('u_bank', 'g2', 1, 'whole_submission')] }, groups('g1', 'g2'))).toBeNull();
  });

  it('own_unit wins when a caller holds both kinds, and the caller sees the union of their units', () => {
    expect(seen('g_applicant', 'g_contact')).toEqual(['intro', ...APPLICANT, ...CONTACT]);
    expect(seen('g_applicant', 'g_bank')).toEqual(['intro', ...APPLICANT, ...BANK]);
  });

  it('is a set in document order, and takes any iterable of group ids', () => {
    const set = visibleBlocksForReviewer(compiled, settings, new Set(groups('g_bank')));
    expect(set instanceof Set).toBe(true);
    expect([...(set ?? [])]).toEqual(compiled.documentOrder.filter((b) => b === 'intro' || BANK.includes(b)));
  });

  it('hides a block it does not know by default', () => {
    const set = visibleBlocksForReviewer(compiled, settings, groups('g_bank'));
    expect(set?.has(bid('removed_block'))).toBe(false);
  });

  describe('when the live settings and the submission\'s version disagree', () => {
    /**
     * The version a submission was made on holds u_applicant and u_contact; the live settings have since added u_new (and
     * u_new_whole), which this version does not hold. In this version the bank page belongs to no unit.
     */
    const v1 = versionOf(withUnits(reviewForm(), reviewUnit('u_applicant', breakTarget('brk_a')), reviewUnit('u_contact', breakTarget('brk_b'))));
    const live = {
      units: [
        assign('u_applicant', 'g_x', 1, 'own_unit'), assign('u_contact', 'g_y', 1, 'own_unit'),
        assign('u_new', 'g_z', 2, 'own_unit'), assign('u_new_whole', 'g_w', 2, 'whole_submission'),
      ],
    };
    const see = (...g: string[]) => {
      const set = visibleBlocksForReviewer(v1.compiled, live, groups(...g));
      return set === null ? null : [...set];
    };
    const OUTSIDE = ['intro', 'brk_c', 'bank', 'ifsc'];

    it('a checker of an own_unit unit this version lacks sees only the blocks outside all units, never the whole submission', () => {
      expect(see('g_z')).toEqual(OUTSIDE);
      expect(see('g_z')).not.toContain('applicant');
      expect(see('g_z')).not.toContain('email');
    });

    it('the checker of a unit the version holds still sees that unit and not the other, and a whole_submission unit the version lacks does not redact', () => {
      expect(see('g_x')).toEqual(['intro', 'brk_a', 'applicant', 'has_bank', 'address', 'brk_c', 'bank', 'ifsc']);
      expect(see('g_y')).toEqual(['intro', 'brk_b', 'contact', 'email', 'phone', 'brk_c', 'bank', 'ifsc']);
      expect(see('g_w')).toBeNull();
    });

    it('own_unit on a missing unit wins over whole_submission on another, and adds nothing to what the caller sees', () => {
      expect(see('g_z', 'g_w')).toEqual(OUTSIDE);
      expect(see('g_z', 'g_x')).toEqual(see('g_x'));
    });

    it('a caller in no group of this form is still not redacted', () => {
      expect(see()).toBeNull();
      expect(see('g_elsewhere')).toBeNull();
    });
  });

  describe('values worked out from a hidden block', () => {
    const num = (blockId: string): S.Expr => ({ k: 'ref', ref: { kind: 'answer', blockId: bid(blockId) } });
    const lit = (n: string): S.Expr => ({ k: 'lit', value: { type: 'number', value: id<S.DecimalString>(n) } });
    const calc = (blockId: string, e: S.Expr) => field('calculation', blockId, { config: { expr: e, resultType: 'number', display: 'visible' } });
    const plus = (left: S.Expr, right: S.Expr): S.Expr => ({ k: 'binary', op: '+', left, right });
    /**
     * top and top_x2 sit before the first break; shadow (outside every unit) reads unit B; in unit A, a_x2 reads A, a_copy reads B and
     * a_chain reads a_copy; in unit B, b_from_a reads A and b_x2 reads B.
     */
    const calcForm = () => withUnits(form([
      field('number', 'top'), calc('top_x2', plus(num('top'), lit('1'))), calc('shadow', plus(num('b_amount'), lit('1'))),
      sectionBreak('brk_a'), field('number', 'a_amount'), calc('a_x2', plus(num('a_amount'), num('a_amount'))),
      calc('a_copy', num('b_amount')), calc('a_chain', plus(num('a_copy'), lit('1'))),
      sectionBreak('brk_b'), field('number', 'b_amount'), calc('b_from_a', num('a_amount')), calc('b_x2', plus(num('b_amount'), lit('2'))),
    ], [page('p1', ['top', 'top_x2', 'shadow', 'brk_a', 'a_amount', 'a_x2', 'a_copy', 'a_chain']), page('p2', ['brk_b', 'b_amount', 'b_from_a', 'b_x2'])]),
    reviewUnit('A', breakTarget('brk_a')), reviewUnit('B', breakTarget('brk_b')));
    const v = versionOf(calcForm());
    const assignments = { units: [assign('A', 'g_a', 1, 'own_unit'), assign('B', 'g_b', 1, 'own_unit')] };
    const sees = (...g: string[]) => [...(visibleBlocksForReviewer(v.compiled, assignments, groups(...g)) ?? [])];

    it('a calculation outside every unit that reads unit B is hidden from a unit-A checker, and shown to unit B\'s', () => {
      expect(sees('g_a')).not.toContain('shadow');
      expect(sees('g_b')).toContain('shadow');
    });

    it('a calculation inside the caller\'s unit that copies another unit\'s answer is hidden, and so is one that reads that calculation', () => {
      expect(sees('g_a')).toEqual(['top', 'top_x2', 'brk_a', 'a_amount', 'a_x2']);
      expect(sees('g_a')).not.toContain('a_copy');
      expect(sees('g_a')).not.toContain('a_chain');
      expect(sees('g_b')).toEqual(['top', 'top_x2', 'shadow', 'brk_b', 'b_amount', 'b_x2']);
      expect(sees('g_b')).not.toContain('b_from_a');
    });

    it('keeps a calculation that reads only blocks the caller sees', () => {
      expect(sees('g_a')).toEqual(expect.arrayContaining(['top_x2', 'a_x2']));
      expect(sees('g_b')).toEqual(expect.arrayContaining(['top_x2', 'b_x2']));
    });

    it('a caller who is not redacted sees every derived value, whatever it reads', () => {
      expect(visibleBlocksForReviewer(v.compiled, assignments, groups('g_other'))).toBeNull();
      expect(visibleBlocksForReviewer(v.compiled, { units: [assign('A', 'g_a', 1, 'whole_submission')] }, groups('g_a'))).toBeNull();
    });

    it('a checker of both units sees both units\' calculations', () => {
      expect(sees('g_a', 'g_b')).toEqual(v.compiled.documentOrder);
    });

    it('follows variable, default and calc steps through the compiled reads, to a fixed point', () => {
      /* Hand-built: v1 reads B's value, c1 (a calc in A) reads v1, d1 (a default outside every unit) reads c1, ok reads only A.
       * A's checker loses c1 (through v1) and d1 (through c1); B's checker loses A's blocks and d1, which reads one of them. */
      const compiledByHand = {
        documentOrder: ['brk_a', 'a', 'c1', 'ok', 'brk_b', 'b', 'd1'].map(bid),
        reviewUnits: { A: ['brk_a', 'a', 'c1', 'ok'].map(bid), B: ['brk_b', 'b'].map(bid) },
        plan: [
          { kind: 'default', blockId: bid('d1') }, { kind: 'calc', blockId: bid('c1') }, { kind: 'variable', varId: id<S.VariableId>('v1') },
          { kind: 'calc', blockId: bid('ok') },
        ],
        reads: { 'default:d1': ['value:c1'], 'calc:c1': ['var:v1'], 'variable:v1': ['value:b', 'visible:b'], 'calc:ok': ['value:a'] },
      } as unknown as Parameters<typeof visibleBlocksForReviewer>[0];
      expect([...(visibleBlocksForReviewer(compiledByHand, assignments, groups('g_a')) ?? [])]).toEqual(['brk_a', 'a', 'ok']);
      expect([...(visibleBlocksForReviewer(compiledByHand, assignments, groups('g_b')) ?? [])]).toEqual(['brk_b', 'b']);
    });

    it('does not follow a visibility read: a rule that shows a block of the caller\'s unit is not a value', () => {
      const gated = withUnits(form([
        sectionBreak('brk_a'), field('short_text', 'a'), field('short_text', 'a_late'),
        sectionBreak('brk_b'), field('short_text', 'b'),
      ], [page('p1', ['brk_a', 'a', 'a_late', 'brk_b', 'b'])], [rule('r', cond(ans('b'), 'eq', text('x')), [hide('a_late')])]),
      reviewUnit('A', breakTarget('brk_a')), reviewUnit('B', breakTarget('brk_b')));
      const gv = versionOf(gated);
      expect([...(visibleBlocksForReviewer(gv.compiled, assignments, groups('g_a')) ?? [])]).toEqual(['brk_a', 'a', 'a_late']);
    });

    it('logic variables are still refused by compile, which this function relies on', () => {
      const withVariable = form([field('short_text', 'name')], [page('p1', ['name'])]);
      withVariable.logic.variables = [{ id: id<S.VariableId>('v1'), key: id<S.FieldKey>('v1'), name: 'v', type: 'number', expr: lit('1'), persist: false }];
      const variable = compile(withVariable, REGISTRY);
      expect(!variable.ok && variable.issues.some((i) => i.code === 'missing_capability' && i.path === '/logic/variables/0')).toBe(true);
    });
  });

  /*
   * WP-2.01 (founder, 25 Nov 2026): rules that write values (set, percent, fill from an option) are allowed, so a rule can
   * carry another unit's answer into a field the caller's unit holds. The written field is derived from everything the
   * rule's condition and value read, through chains, and is hidden wherever any of those is.
   */
  describe('values a rule sets from a hidden block (set_value)', () => {
    const textRef = (blockId: string): S.Expr => ({ k: 'ref', ref: { kind: 'answer', blockId: bid(blockId) } });
    const set = (target: string, value: S.Expr): S.Action => ({ type: 'set_value', target: bid(target), value });
    const lit = (n: string): S.Expr => ({ k: 'lit', value: { type: 'number', value: id<S.DecimalString>(n) } });
    const word = (v: string): S.Expr => ({ k: 'lit', value: { type: 'text', value: v } });
    const percentOf = (blockId: string, pct: string): S.Expr => ({ k: 'binary', op: '/', left: { k: 'binary', op: '*', left: textRef(blockId), right: lit(pct) }, right: lit('100') });
    const optionCode = (blockId: string): S.Expr => ({ k: 'call', fn: 'option_code', args: [textRef(blockId)] });
    const assignments = { units: [assign('A', 'g_a', 1, 'own_unit'), assign('B', 'g_b', 1, 'own_unit')] };
    const BANKS = [{ id: oid('hdfc'), label: 'HDFC', code: '501' }, { id: oid('sbi'), label: 'SBI', code: '602' }];
    /**
     * Unit A (brk_a) holds the fields the rules write; unit B (brk_b) holds the sources: a text, a number and a dropdown.
     * `top` sits before the first break (outside every unit) and is the middle link of the chain.
     */
    const setForm = (rules: S.Rule[]) => withUnits(form([
      field('short_text', 'top'), field('calculation', 'top_calc', { config: { expr: { k: 'binary', op: '+', left: textRef('top_n'), right: lit('1') }, resultType: 'number', display: 'visible' } }),
      field('number', 'top_n'),
      sectionBreak('brk_a'), field('short_text', 'a_name'), field('short_text', 'a_copy'), field('short_text', 'a_flag'), field('short_text', 'a_own'),
      field('number', 'a_amount'), field('number', 'a_fee'), field('short_text', 'a_bank_code', { readOnly: true }),
      sectionBreak('brk_b'), field('short_text', 'b_name'), field('number', 'b_amount'),
      field('single_choice', 'b_bank', { config: { display: 'dropdown', options: BANKS } }),
    ], [page('p1', ['top', 'top_n', 'top_calc', 'brk_a', 'a_name', 'a_copy', 'a_flag', 'a_own', 'a_amount', 'a_fee', 'a_bank_code']), page('p2', ['brk_b', 'b_name', 'b_amount', 'b_bank'])], rules),
    reviewUnit('A', breakTarget('brk_a')), reviewUnit('B', breakTarget('brk_b')));
    const seenBy = (def: S.FormDefinition, ...g: string[]) => [...(visibleBlocksForReviewer(versionOf(def).compiled, assignments, groups(...g)) ?? [])];
    const B_ANSWERS = { [bid('a_name')]: a.text('Asha'), [bid('a_amount')]: a.number('1000'), [bid('b_name')]: a.text('secret-b'), [bid('b_amount')]: a.number('2000'), [bid('b_bank')]: a.single('sbi') };

    it('a field a rule copies from another unit\'s answer is hidden from the caller\'s unit, though it sits in it', () => {
      const def = setForm([rule('copy', cond(ans('a_name'), 'is_answered'), [set('a_copy', textRef('b_name'))])]);
      /* The copy is real: the evaluator writes unit B's answer into a_copy, which unit A holds. */
      expect(evaluate(versionOf(def), B_ANSWERS, META, 'server').values[bid('a_copy')]).toEqual(a.text('secret-b'));
      expect(seenBy(def, 'g_a')).not.toContain('a_copy');
      expect(seenBy(def, 'g_a')).toEqual(['top', 'top_n', 'top_calc', 'brk_a', 'a_name', 'a_flag', 'a_own', 'a_amount', 'a_fee', 'a_bank_code']);
      /* B's checker does not see unit A at all; a checker of both sees it. */
      expect(seenBy(def, 'g_a', 'g_b')).toContain('a_copy');
    });

    it('a field a rule sets because of another unit\'s answer is hidden too: the condition\'s reads count, not only the value\'s', () => {
      const def = setForm([rule('flag', cond(ans('b_amount'), 'gt', num('1500')), [set('a_flag', word('big'))])]);
      expect(evaluate(versionOf(def), B_ANSWERS, META, 'server').values[bid('a_flag')]).toEqual(a.text('big'));
      expect(seenBy(def, 'g_a')).not.toContain('a_flag');
    });

    it('follows a chain of rules and a calculation: B → a_copy (rule) → top (rule) → reader, to a fixed point', () => {
      const def = setForm([
        rule('copy', cond(ans('a_name'), 'is_answered'), [set('a_copy', textRef('b_name'))]),
        rule('relay', cond(ans('a_name'), 'is_answered'), [set('top', textRef('a_copy'))]),
        rule('count', cond(ans('top'), 'is_answered'), [set('top_n', lit('1'))]),
      ]);
      const state = evaluate(versionOf(def), B_ANSWERS, META, 'server');
      expect(state.values[bid('top')]).toEqual(a.text('secret-b'));
      const seen = seenBy(def, 'g_a');
      for (const leaked of ['a_copy', 'top', 'top_n', 'top_calc']) expect(seen).not.toContain(leaked);
      expect(seen).toEqual(['brk_a', 'a_name', 'a_flag', 'a_own', 'a_amount', 'a_fee', 'a_bank_code']);
    });

    it('a field filled from a hidden dropdown\'s option code (Fill from option) is hidden', () => {
      const def = setForm([rule('fill', cond(ans('b_bank'), 'is_answered'), [set('a_bank_code', optionCode('b_bank'))])]);
      expect(evaluate(versionOf(def), B_ANSWERS, META, 'server').values[bid('a_bank_code')]).toEqual(a.text('602'));
      expect(seenBy(def, 'g_a')).not.toContain('a_bank_code');
    });

    it('a percent of a hidden number is hidden', () => {
      const def = setForm([rule('fee', cond(ans('a_amount'), 'is_answered'), [set('a_fee', percentOf('b_amount', '10'))])]);
      expect(evaluate(versionOf(def), B_ANSWERS, META, 'server').values[bid('a_fee')]).toEqual(a.number('200'));
      expect(seenBy(def, 'g_a')).not.toContain('a_fee');
    });

    it('the else branch writes as well, and a rule that reads only the caller\'s blocks leaves its target shown', () => {
      const def = setForm([
        rule('mine', cond(ans('a_amount'), 'gt', num('10')), [set('a_fee', percentOf('a_amount', '5'))], [set('a_own', textRef('a_name'))]),
        rule('theirs', cond(ans('a_amount'), 'gt', num('10')), [set('a_flag', word('x'))], [set('a_copy', textRef('b_name'))]),
      ]);
      const seen = seenBy(def, 'g_a');
      expect(seen).toEqual(expect.arrayContaining(['a_fee', 'a_own']));
      expect(seen).not.toContain('a_copy');
      /* A rule is one step: every field it writes is derived from everything any of its actions reads (conservative). */
      expect(seen).not.toContain('a_flag');
      /* B's checker loses nothing of unit B: the rules read unit A, whose blocks B's checker never sees anyway. */
      expect(seenBy(def, 'g_b')).toEqual(['top', 'top_n', 'top_calc', 'brk_b', 'b_name', 'b_amount', 'b_bank']);
    });

    it('compiles the rule writes into compiled.ruleWrites, and a form without such rules has none', () => {
      const def = setForm([rule('copy', cond(ans('a_name'), 'is_answered'), [set('a_copy', textRef('b_name'))])]);
      expect(versionOf(def).compiled.ruleWrites).toEqual({ 'rule:copy': ['value:a_copy'] });
      expect(versionOf(setForm([rule('r', cond(ans('a_name'), 'is_answered'), [hide('a_own')])])).compiled.ruleWrites).toBeUndefined();
    });

    it('fails closed on a jsonb-loaded scoping whose ruleWrites is null (a version without such rules)', () => {
      const { compiled } = versionOf(setForm([]));
      const loaded = { ...compiled, ruleWrites: null } as unknown as Parameters<typeof visibleBlocksForReviewer>[0];
      expect([...(visibleBlocksForReviewer(loaded, assignments, groups('g_a')) ?? [])]).toContain('a_copy');
    });
  });

  it('a form version without units has every block outside all units, so an own_unit checker sees all of it and a stranger is not redacted', () => {
    const plain = versionOf(twoPages()).compiled;
    expect([...(visibleBlocksForReviewer(plain, settings, groups('g_bank')) ?? [])]).toEqual(plain.documentOrder);
    expect(visibleBlocksForReviewer(plain, settings, groups('g_unrelated'))).toBeNull();
  });
});

describe('determinism corpus entry', () => {
  const cases = reviewCases();
  type Parsed = { applicable: Array<{ unitId: string; state: string }>; hashes: Record<string, string>; seen: Array<string[] | null> };
  const parsed = cases.map((c) => JSON.parse(c.json) as Parsed);

  it('is stable from run to run and has one case per seeded answer set', () => {
    expect(cases).toHaveLength(40);
    expect(reviewCases()).toEqual(cases);
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });

  it('covers applicable and not_applicable units, changing hashes, and every kind of caller', () => {
    const states = new Set(parsed.flatMap((p) => p.applicable.map((u) => `${u.unitId}:${u.state}`)));
    expect([...states].sort()).toEqual([
      'u_applicant:applicable', 'u_bank:applicable', 'u_bank:not_applicable', 'u_contact:applicable', 'u_contact:not_applicable',
    ]);
    expect(new Set(parsed.map((p) => p.hashes['u_applicant'])).size).toBeGreaterThan(5);
    const [none, applicant, contact, bank, both, wholePlusBank, unknown] = parsed[0]?.seen ?? [];
    expect(none).toBeNull();
    expect(contact).toBeNull();
    expect(unknown).toBeNull();
    expect(applicant).toContain('applicant');
    expect(applicant).not.toContain('email');
    expect(bank).not.toContain('applicant');
    expect(both).toContain('email');
    expect(wholePlusBank).toContain('bank');
    expect(wholePlusBank).toContain('email');
    expect(wholePlusBank).not.toContain('applicant');
  });
});

describe('forms without review (backward compatibility)', () => {
  it('every existing corpus form still parses with the strict twin, has no review key, and compiles without reviewUnits', () => {
    for (const v1 of V1_FORMS) {
      const def = toV2(v1);
      expect('review' in def, v1.name).toBe(false);
      const parsed = FormDefinitionSchema.safeParse(JSON.parse(JSON.stringify(def)));
      expect(parsed.success, v1.name).toBe(true);
      const result = compile(def, REGISTRY);
      expect(result.ok && 'reviewUnits' in result.compiled, v1.name).toBe(false);
      expect(reviewUnitIssues(def, 'publish'), v1.name).toEqual([]);
    }
  });
});
