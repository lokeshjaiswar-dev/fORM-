import { describe, expect, it } from 'vitest';
import { diffDrafts, sameDefinition } from '@/lib/draftDiff';
import { block, formWith } from '@/test/fixtures';

describe('sameDefinition', () => {
  it('compares JSON by value, whatever the key order', () => {
    expect(sameDefinition({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameDefinition({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameDefinition({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameDefinition([1, 2], [2, 1])).toBe(false);
    expect(sameDefinition({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameDefinition(null, {})).toBe(false);
    expect(sameDefinition([], {})).toBe(false);
  });
});

describe('diffDrafts', () => {
  const base = () => formWith([block('short_text', 'name', { label: 'Name' }), block('short_text', 'mail', { label: 'Email' })]);

  it('finds nothing between a draft and a copy of it', () => {
    expect(diffDrafts(base(), structuredClone(base()))).toMatchObject({ identical: true, onlyMine: [], onlyTheirs: [], changed: [], form: [] });
  });

  it('names the blocks that are only in one draft, and the ones that differ, by label and type', () => {
    const mine = formWith([block('short_text', 'name', { label: 'Name' }), block('short_text', 'mail', { label: 'Email address' }), block('short_text', 'phone', { label: 'Phone' })]);
    const theirs = formWith([block('short_text', 'name', { label: 'Name' }), block('short_text', 'mail', { label: 'Email' }), block('short_text', 'city', { label: 'City' })]);
    const diff = diffDrafts(mine, theirs);
    expect(diff.onlyMine).toEqual([{ id: 'phone', label: 'Phone', type: 'short_text' }]);
    expect(diff.onlyTheirs).toEqual([{ id: 'city', label: 'City', type: 'short_text' }]);
    expect(diff.changed).toEqual([{ id: 'mail', label: 'Email address', type: 'short_text' }]);
    expect(diff.identical).toBe(false);
  });

  it('names the form-level parts that differ, and ignores the revision counter', () => {
    const mine = { ...base(), title: 'Mine', revision: 3 };
    const theirs = { ...base(), title: 'Theirs', revision: 9, pages: [{ ...base().pages[0]!, children: [...base().pages[0]!.children].reverse() }] };
    expect(diffDrafts(mine, theirs).form).toEqual(['title', 'pages']);
    expect(diffDrafts({ ...base(), revision: 1 }, { ...base(), revision: 2 }).identical).toBe(true);
  });
});
