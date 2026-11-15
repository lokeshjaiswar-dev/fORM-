import { describe, expect, it } from 'vitest';
import type { BlockId, FormDefinition, PageId, ReviewGroupId, ReviewSettings, ReviewUnit, ReviewUnitAssignment, ReviewUnitId, StoredBlock } from '@form/schema';
import {
  assignmentOf,
  assignmentProblems,
  describeTarget,
  isChanged,
  newAssignment,
  orphansOf,
  targetOptions,
  unitBlocks,
  unitProblems,
  withAssignment,
  withoutRefusedOrphans,
} from '@/components/builder/review/reviewModel';
import { block, formWith } from '@/test/fixtures';

/** A payment block. The registry does not offer one yet (WP-2.11), and the unit checks look only at the block's type. */
const payment = (id: string) => ({ ...block('short_text', id), type: 'payment' }) as unknown as StoredBlock;
const unit = (id: string, name: string, target: ReviewUnit['target']): ReviewUnit => ({ id: id as ReviewUnitId, name, target });
const page = (id: string): ReviewUnit['target'] => ({ kind: 'page', pageId: id as PageId });
const brk = (id: string): ReviewUnit['target'] => ({ kind: 'section_break', blockId: id as BlockId });
const A = (unitId: string, groupId: string, over: Partial<ReviewUnitAssignment> = {}): ReviewUnitAssignment => ({ ...newAssignment(unitId, groupId), ...over });
const settings = (units: ReviewUnitAssignment[], over: Partial<ReviewSettings> = {}): ReviewSettings => ({ enabled: true, distinctCheckers: false, units, ...over });

function form(review?: ReviewUnit[]): FormDefinition {
  const def = formWith([
    [block('short_text', 'name', { label: 'Full name' }), block('section_break', 'sbA', { config: { name: 'Section A' } }), block('short_text', 'email', { label: 'Email' })],
    [block('section_break', 'sbB', { config: { name: 'Section B' } }), block('short_text', 'phone', { label: 'Phone' })],
  ]);
  return review ? { ...def, review: { units: review } } : def;
}

describe('targetOptions', () => {
  it('offers every page and section break, pages first, with the name a new unit starts with', () => {
    expect(targetOptions(form())).toEqual([
      { value: 'page:page_1', label: 'Page 1', target: page('page_1'), name: 'Page 1' },
      { value: 'page:page_2', label: 'Page 2', target: page('page_2'), name: 'Page 2' },
      { value: 'break:sbA', label: 'Section break: Section A', target: brk('sbA'), name: 'Section A' },
      { value: 'break:sbB', label: 'Section break: Section B', target: brk('sbB'), name: 'Section B' },
    ]);
  });

  it('leaves out what has a unit already, and names a page by its title when it has one', () => {
    const def = form([unit('u1', 'x', page('page_1')), unit('u2', 'y', brk('sbB'))]);
    def.pages[1] = { ...def.pages[1]!, title: 'Contact' };
    expect(targetOptions(def).map((o) => [o.value, o.label, o.name])).toEqual([
      ['page:page_2', 'Page 2: Contact', 'Contact'],
      ['break:sbA', 'Section break: Section A', 'Section A'],
    ]);
  });

  it('names a section break that has no name', () => {
    const def = formWith([[block('section_break', 'sb', { config: { name: '  ' } })]]);
    expect(targetOptions(def).find((o) => o.value === 'break:sb')).toMatchObject({ label: 'Section break', name: 'Section break' });
  });
});

describe('describeTarget', () => {
  it('says where a unit points, and when that is gone', () => {
    const def = form();
    expect(describeTarget(def, page('page_2'))).toEqual({ label: 'Page 2', gone: false });
    expect(describeTarget(def, brk('sbA'))).toEqual({ label: 'Section break: Section A', gone: false });
    expect(describeTarget(def, page('page_9')).gone).toBe(true);
    // A block that exists but is not a section break is not a target either.
    expect(describeTarget(def, brk('name')).gone).toBe(true);
    expect(describeTarget(def, brk('missing')).gone).toBe(true);
  });
});

describe('unitBlocks', () => {
  it('lists what a page covers and what a section break covers up to the next one, across pages, labelled', () => {
    const def = form([unit('p1', 'P1', page('page_1')), unit('s1', 'S1', brk('sbA')), unit('s2', 'S2', brk('sbB'))]);
    expect(unitBlocks(def)).toEqual({
      p1: [{ id: 'name', label: 'Full name' }, { id: 'sbA', label: 'Section A' }, { id: 'email', label: 'Email' }],
      s1: [{ id: 'sbA', label: 'Section A' }, { id: 'email', label: 'Email' }],
      s2: [{ id: 'sbB', label: 'Section B' }, { id: 'phone', label: 'Phone' }],
    });
  });

  it('labels a block with no text by its type', () => {
    const def = { ...formWith([[block('divider', 'd')]]), review: { units: [unit('p', 'P', page('page_1'))] } };
    expect(unitBlocks(def)['p']).toEqual([{ id: 'd', label: 'Untitled divider' }]);
  });
});

describe('unitProblems', () => {
  it('has nothing to say about a form without units, or with units that are fine', () => {
    expect(unitProblems(form())).toEqual({});
    expect(unitProblems(form([unit('s1', 'S1', brk('sbA')), unit('s2', 'S2', brk('sbB'))]))).toEqual({});
  });

  it('names the units a unit overlaps, on each of them', () => {
    const problems = unitProblems(form([unit('p1', 'Applicant', page('page_1')), unit('s1', 'Section A part', brk('sbA')), unit('s2', 'Section B part', brk('sbB'))]));
    expect(problems['p1']?.map((p) => p.code)).toEqual(['review_unit_overlap']);
    expect(problems['p1']?.[0]?.message).toBe('This unit shares questions with “Section A part”. A question can belong to only one unit. The form cannot be published like this.');
    expect(problems['s1']?.[0]?.message).toContain('“Applicant”');
    expect(problems['s2']).toBeUndefined();
  });

  it('reports a unit that covers only its own break as empty, a payment, and a target that is gone', () => {
    // The break is the last block of the form, so the unit that starts at it covers nothing else.
    const def = formWith([[payment('pay')], [block('section_break', 'sb', { config: { name: 'Only a break' } })]]);
    const problems = unitProblems({ ...def, review: { units: [unit('e', 'E', brk('sb')), unit('pay', 'Pay', page('page_1')), unit('g', 'G', page('page_9'))] } });
    expect(problems['e']?.map((p) => p.code)).toEqual(['review_unit_empty']);
    expect(problems['pay']?.map((p) => p.code)).toEqual(['review_unit_contains_payment']);
    expect(problems['g']?.map((p) => p.code)).toEqual(['review_unit_dangling_target']);
  });
});

describe('assignments', () => {
  const G1 = 'g1';
  const G2 = 'g2';

  it('adds an assignment with first-in-order, required, own-unit defaults, replaces one in place, and removes one', () => {
    const empty = settings([]);
    const one = withAssignment(empty, 'u1', newAssignment('u1', G1));
    expect(one.units).toEqual([{ unitId: 'u1', groupId: 'g1', order: 1, required: true, visibility: 'own_unit' }]);
    const two = withAssignment(one, 'u2', A('u2', G2));
    const changed = withAssignment(two, 'u1', A('u1', G2, { order: 3 }));
    expect(changed.units.map((a) => [a.unitId, a.groupId, a.order])).toEqual([['u1', 'g2', 3], ['u2', 'g2', 1]]);
    expect(withAssignment(changed, 'u1', null).units.map((a) => a.unitId)).toEqual(['u2']);
    expect(assignmentOf(changed, 'u2')?.groupId).toBe('g2');
    expect(assignmentOf(changed, 'nope')).toBeUndefined();
    // Nothing was changed in place.
    expect(empty.units).toEqual([]);
  });

  it('compares settings by unit, so the order of the list is no change', () => {
    const a = settings([A('u1', G1), A('u2', G2)]);
    expect(isChanged(a, settings([A('u2', G2), A('u1', G1)]))).toBe(false);
    expect(isChanged(a, settings([A('u1', G1), A('u2', G2)], { enabled: false }))).toBe(true);
    expect(isChanged(a, settings([A('u1', G1), A('u2', G2)], { distinctCheckers: true }))).toBe(true);
    expect(isChanged(a, settings([A('u1', G1), A('u2', G2, { required: false })]))).toBe(true);
    expect(isChanged(a, settings([A('u1', G1)]))).toBe(true);
  });

  it('finds the assignments of units the draft does not have, and judges only the groups of those it does', () => {
    const def = form([unit('u1', 'U1', page('page_1')), unit('u2', 'U2', page('page_2'))]);
    const s = settings([A('u1', G1), A('u2', 'archived'), A('live-only', 'whatever')]);
    expect(orphansOf(s, def).map((a) => a.unitId)).toEqual(['live-only']);
    expect(assignmentProblems(s, def, new Set([G1]))).toEqual({ u2: 'This unit’s group no longer exists or is archived. Choose another group.' });
    // Groups that could not be read are not judged.
    expect(assignmentProblems(s, def, null)).toEqual({});
  });

  describe('withoutRefusedOrphans', () => {
    const def = form([unit('u1', 'U1', page('page_1'))]);
    const s = settings([A('u1', G1), A('old', G1), A('older', G2)]);

    it('drops the assignments of units in no version when those are all the server refused', () => {
      const next = withoutRefusedOrphans(s, def, [{ path: 'body/units/1/unitId' }, { path: 'body/units/2/groupId' }]);
      expect(next?.units.map((a) => a.unitId)).toEqual(['u1']);
    });

    it('refuses to guess when the server named a unit of this draft, or something else, or nothing', () => {
      expect(withoutRefusedOrphans(s, def, [{ path: 'body/units/0/groupId' }])).toBeNull();
      expect(withoutRefusedOrphans(s, def, [{ path: 'body/units/1/unitId' }, { path: 'body/units/0/groupId' }])).toBeNull();
      expect(withoutRefusedOrphans(s, def, [{ path: 'body/enabled' }])).toBeNull();
      expect(withoutRefusedOrphans(s, def, [{ path: 'body/units/7/unitId' }])).toBeNull();
      expect(withoutRefusedOrphans(s, def, [])).toBeNull();
    });
  });
});

describe('the groups as branded ids', () => {
  it('keeps the ids the server sent untouched', () => {
    const a = newAssignment('u1', 'g1');
    expect(a.groupId).toBe('g1' as ReviewGroupId);
  });
});
