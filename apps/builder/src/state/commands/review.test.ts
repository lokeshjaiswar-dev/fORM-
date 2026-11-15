import { beforeEach, describe, expect, it } from 'vitest';
import type { BlockId, FormDefinition, PageId, ReviewUnit, ReviewUnitId } from '@form/schema';
import { applyCommand, coalesceKey, dispatch } from '@/state/commands/dispatch';
import { MAX_UNIT_NAME } from '@/state/commands/review';
import type { Command } from '@/state/commands/types';
import { undo } from '@/state/history';
import { block, doc, formWith, resetStore } from '@/test/fixtures';

const unit = (id: string, name: string, target: ReviewUnit['target']): ReviewUnit => ({ id: id as ReviewUnitId, name, target });
const page = (id: string): ReviewUnit['target'] => ({ kind: 'page', pageId: id as PageId });
const brk = (id: string): ReviewUnit['target'] => ({ kind: 'section_break', blockId: id as BlockId });

const base = (): FormDefinition => formWith([[block('short_text', 'a', { label: 'A' }), block('section_break', 'sb', { config: { name: 'S' } })], [block('short_text', 'b', { label: 'B' })]]);
const run = (def: FormDefinition, command: Command) => applyCommand(def, command);

beforeEach(() => resetStore());

describe('review unit commands', () => {
  it('adds a unit for a page and for a section break; the first creates `review`', () => {
    const first = run(base(), { type: 'add_review_unit', unit: unit('u1', 'Page 1', page('page_1')) });
    expect(first.ok && first.doc.review).toEqual({ units: [unit('u1', 'Page 1', page('page_1'))] });
    if (!first.ok) throw new Error(first.error);
    const second = run(first.doc, { type: 'add_review_unit', unit: unit('u2', 'S', brk('sb')) });
    expect(second.ok && second.doc.review?.units.map((u) => u.id)).toEqual(['u1', 'u2']);
  });

  it('is pure: the document it was given is untouched and the rest of it is shared', () => {
    const before = base();
    const snapshot = structuredClone(before);
    const result = run(before, { type: 'add_review_unit', unit: unit('u1', 'Page 1', page('page_1')) });
    expect(before).toEqual(snapshot);
    expect(result.ok && result.doc.blocks).toBe(before.blocks);
    expect(result.ok && result.doc.pages).toBe(before.pages);
  });

  it('refuses a unit that is not valid, changing nothing', () => {
    const def = base();
    const refused = (command: Command) => {
      const result = run(def, command);
      return result.ok ? null : result.error;
    };
    // The twin: unknown keys, a target kind that does not exist, a pipe in a name.
    expect(refused({ type: 'add_review_unit', unit: { ...unit('u1', 'x', page('page_1')), extra: 1 } as ReviewUnit })).not.toBeNull();
    expect(refused({ type: 'add_review_unit', unit: { id: 'u1', name: 'x', target: { kind: 'section', blockId: 'sb' } } as unknown as ReviewUnit })).not.toBeNull();
    expect(refused({ type: 'add_review_unit', unit: unit('u1', [{ pipe: { blockId: 'a' } }] as unknown as string, page('page_1')) })).not.toBeNull();
    // The document: a page or a break that is not there, a block that is not a break, a name that is empty or too long.
    expect(refused({ type: 'add_review_unit', unit: unit('u1', 'x', page('page_9')) })).toMatch(/no page/);
    expect(refused({ type: 'add_review_unit', unit: unit('u1', 'x', brk('a')) })).toMatch(/not a section break/);
    expect(refused({ type: 'add_review_unit', unit: unit('u1', 'x', brk('missing')) })).toMatch(/not a section break/);
    expect(refused({ type: 'add_review_unit', unit: unit('u1', '   ', page('page_1')) })).toMatch(/1 to/);
    expect(refused({ type: 'add_review_unit', unit: unit('u1', 'x'.repeat(MAX_UNIT_NAME + 1), page('page_1')) })).toMatch(/1 to/);
  });

  it('refuses a second unit for the same page or break, and a repeated id', () => {
    const one = run(base(), { type: 'add_review_unit', unit: unit('u1', 'Page 1', page('page_1')) });
    if (!one.ok) throw new Error(one.error);
    const again = run(one.doc, { type: 'add_review_unit', unit: unit('u2', 'Again', page('page_1')) });
    expect(again.ok).toBe(false);
    expect(run(one.doc, { type: 'add_review_unit', unit: unit('u1', 'Same id', brk('sb')) })).toMatchObject({ ok: false });
    const withBreak = run(one.doc, { type: 'add_review_unit', unit: unit('u3', 'S', brk('sb')) });
    if (!withBreak.ok) throw new Error(withBreak.error);
    expect(run(withBreak.doc, { type: 'add_review_unit', unit: unit('u4', 'S again', brk('sb')) })).toMatchObject({ ok: false });
  });

  it('renames a unit and refuses an empty name or a unit that is not there', () => {
    const one = run(base(), { type: 'add_review_unit', unit: unit('u1', 'Page 1', page('page_1')) });
    if (!one.ok) throw new Error(one.error);
    const renamed = run(one.doc, { type: 'rename_review_unit', id: 'u1' as ReviewUnitId, name: 'Applicant' });
    expect(renamed.ok && renamed.doc.review?.units[0]?.name).toBe('Applicant');
    expect(run(one.doc, { type: 'rename_review_unit', id: 'u1' as ReviewUnitId, name: ' ' })).toMatchObject({ ok: false });
    expect(run(one.doc, { type: 'rename_review_unit', id: 'nope' as ReviewUnitId, name: 'x' })).toMatchObject({ ok: false });
  });

  it('removes a unit; removing the last takes `review` out of the document', () => {
    const two = run(base(), { type: 'add_review_unit', unit: unit('u1', 'Page 1', page('page_1')) });
    if (!two.ok) throw new Error(two.error);
    const both = run(two.doc, { type: 'add_review_unit', unit: unit('u2', 'S', brk('sb')) });
    if (!both.ok) throw new Error(both.error);
    const left = run(both.doc, { type: 'remove_review_unit', id: 'u1' as ReviewUnitId });
    expect(left.ok && left.doc.review?.units.map((u) => u.id)).toEqual(['u2']);
    if (!left.ok) throw new Error(left.error);
    const none = run(left.doc, { type: 'remove_review_unit', id: 'u2' as ReviewUnitId });
    expect(none.ok && 'review' in none.doc).toBe(false);
    expect(run(left.doc, { type: 'remove_review_unit', id: 'u1' as ReviewUnitId })).toMatchObject({ ok: false });
  });

  it('goes through history: each command is one undo step, and typing a name is one', () => {
    dispatch({ type: 'add_review_unit', unit: unit('u1', 'Page 1', page('page_1')) });
    dispatch({ type: 'rename_review_unit', id: 'u1' as ReviewUnitId, name: 'A' });
    dispatch({ type: 'rename_review_unit', id: 'u1' as ReviewUnitId, name: 'Ap' });
    dispatch({ type: 'rename_review_unit', id: 'u1' as ReviewUnitId, name: 'App' });
    expect(doc().review?.units[0]?.name).toBe('App');
    // The three keystrokes are one step back to the name the unit had.
    undo();
    expect(doc().review?.units[0]?.name).toBe('Page 1');
    undo();
    expect(doc().review).toBeUndefined();
  });

  it('coalesces only the renames of one unit', () => {
    const def = base();
    expect(coalesceKey({ type: 'rename_review_unit', id: 'u1' as ReviewUnitId, name: 'x' }, def)).toBe('review_unit:u1');
    expect(coalesceKey({ type: 'rename_review_unit', id: 'u2' as ReviewUnitId, name: 'x' }, def)).toBe('review_unit:u2');
    expect(coalesceKey({ type: 'add_review_unit', unit: unit('u1', 'x', page('page_1')) }, def)).toBeNull();
    expect(coalesceKey({ type: 'remove_review_unit', id: 'u1' as ReviewUnitId }, def)).toBeNull();
  });

  it('keeps the document valid against the strict definition twin', async () => {
    const { FormDefinitionSchema } = await import('@form/schema');
    const result = run(base(), { type: 'add_review_unit', unit: unit('u1', 'Page 1', page('page_1')) });
    if (!result.ok) throw new Error(result.error);
    expect(FormDefinitionSchema.safeParse(result.doc).success).toBe(true);
  });
});
