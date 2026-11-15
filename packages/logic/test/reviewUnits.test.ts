import { REGISTRY } from '@form/registry';
import { sha256Jcs } from '@form/schema';
import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import {
  applicableUnits, compile, evaluate, reviewUnitAnswersHash, reviewUnitIssues, reviewUnitMembership, validateDefinition, visibleBlocksForReviewer,
} from '../src/index.ts';
import { META, a, ans, bid, cond, field, form, heading, hide, id, page, rule, text, versionOf } from './build.ts';
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

  it('ignores assignments for units this version does not hold, and hides a block it does not know by default', () => {
    expect(visibleBlocksForReviewer(compiled, { units: [assign('u_removed', 'g_old', 1, 'own_unit')] }, groups('g_old'))).toBeNull();
    const set = visibleBlocksForReviewer(compiled, settings, groups('g_bank'));
    expect(set?.has(bid('removed_block'))).toBe(false);
  });

  it('works on a compiled form without units', () => {
    const plain = versionOf(twoPages()).compiled;
    expect(visibleBlocksForReviewer(plain, settings, groups('g_bank'))).toBeNull();
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
