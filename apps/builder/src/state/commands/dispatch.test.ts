import { beforeEach, describe, expect, it } from 'vitest';
import { applyCommand, coalesceKey, dispatch } from '@/state/commands/dispatch';
import type { Command } from '@/state/commands/types';
import { useDocumentStore } from '@/state/documentStore';
import { block, doc, formWith, resetStore } from '@/test/fixtures';
import type { FormBlock } from '@/types/form';

const counter = () => {
  let n = 0;
  return { newId: () => `id_${(n += 1)}` };
};

beforeEach(() => resetStore());

describe('applyCommand', () => {
  it('is pure: the input document is untouched and unchanged parts are shared', () => {
    const before = formWith([block('text', { id: 'a', label: 'A' }), block('text', { id: 'b', label: 'B' })]);
    const snapshot = structuredClone(before);
    const result = applyCommand(before, { type: 'update_block', id: 'a', patch: { label: 'A2' } });
    expect(result.ok).toBe(true);
    expect(before).toEqual(snapshot);
    if (!result.ok) return;
    expect(result.doc.blocks[0].label).toBe('A2');
    expect(result.doc.blocks[1]).toBe(before.blocks[1]);
    expect(result.doc.settings).toBe(before.settings);
  });

  it('takes new ids from the context, so a command list replays to the same document', () => {
    const base = formWith([block('checkbox', { id: 'a', options: [{ id: 'o', label: 'O', value: 'o' }] })]);
    const run = () => {
      const ids = counter();
      const first = applyCommand(base, { type: 'duplicate_block', id: 'a' }, ids);
      if (!first.ok) throw new Error(first.error);
      return applyCommand(first.doc, { type: 'duplicate_block', id: 'a' }, ids);
    };
    expect(run()).toEqual(run());
    const result = run();
    expect(result.ok && result.doc.blocks.map((b) => [b.id, b.options?.[0].id])).toEqual([['a', 'o'], ['id_3', 'id_4'], ['id_1', 'id_2']]);
  });

  it('a top-level undefined in a patch unsets that part of the block; nested undefined values are dropped', () => {
    const base = formWith([block('text', { id: 'a', placeholder: 'x', validation: { required: true, pattern: '^a' } })]);
    const result = applyCommand(base, { type: 'update_block', id: 'a', patch: { placeholder: undefined, validation: { required: true, pattern: undefined } } });
    expect(result.ok && result.doc.blocks[0]).toEqual({ id: 'a', type: 'text', label: '', order: 0, validation: { required: true } });
  });

  it.each<[string, Command]>([
    ['an unknown block key', { type: 'update_block', id: 'a', patch: { colour: 'red' } as unknown as FormBlock }],
    ['a wrong value type', { type: 'update_block', id: 'a', patch: { label: 3 } as unknown as FormBlock }],
    ['a type change', { type: 'update_block', id: 'a', patch: { type: 'email' } as unknown as FormBlock }],
    ['unsetting the label', { type: 'update_block', id: 'a', patch: { label: undefined } as unknown as FormBlock }],
    ['a missing block', { type: 'delete_block', id: 'nope', rules: 'disable' }],
    ['a duplicate block id', { type: 'add_block', block: block('text', { id: 'a' }), index: 0 }],
    ['an index past the end', { type: 'add_block', block: block('text', { id: 'z' }), index: 5 }],
    ['a move out of range', { type: 'move_block', from: 0, to: 1 }],
    ['an unknown setting', { type: 'update_settings', patch: { theme: 'dark' } as unknown as Record<string, never> }],
    ['another document', { type: 'replace_document', doc: { ...formWith([]), id: 'other' } }],
    ['an unknown command', { type: 'rename_form' } as unknown as Command],
  ])('rejects %s and changes nothing', (_, command) => {
    resetStore([block('text', { id: 'a' })]);
    const before = doc();
    const result = dispatch(command);
    expect(result.ok).toBe(false);
    expect(doc()).toBe(before);
    expect(useDocumentStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('a command that changes nothing adds no history', () => {
    resetStore([block('text', { id: 'a', label: 'Same' })]);
    const before = doc();
    expect(dispatch({ type: 'update_block', id: 'a', patch: { label: 'Same' } }).ok).toBe(true);
    expect(doc()).toBe(before);
    expect(useDocumentStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('typing commands coalesce per (block, leaf path) or form field; toggles and structural commands never do', () => {
    const base = formWith([block('text', { id: 'a', customize: { prefix: '', hideLabel: false } })]);
    expect(coalesceKey({ type: 'update_block', id: 'a', patch: { label: 'x' } }, base)).toBe('block:a:label');
    expect(coalesceKey({ type: 'update_block', id: 'a', patch: { placeholder: 'x', helpText: 'y' } }, base)).toBe('block:a:helpText,placeholder');
    expect(coalesceKey({ type: 'update_block', id: 'a', patch: { customize: { prefix: '$', hideLabel: false } } }, base)).toBe('block:a:customize.prefix');
    expect(coalesceKey({ type: 'update_block', id: 'a', patch: { customize: { prefix: '', suffix: 'kg', hideLabel: false } } }, base)).toBe('block:a:customize.suffix');
    expect(coalesceKey({ type: 'update_block', id: 'a', patch: { customize: { prefix: '', hideLabel: true } } }, base)).toBeNull();
    expect(coalesceKey({ type: 'update_block', id: 'a', patch: { label: '' } }, base)).toBeNull();
    const choice = formWith([block('dropdown', { id: 'c', options: [{ id: 'o1', label: 'A', value: 'a' }, { id: 'o2', label: 'B', value: 'b' }] })]);
    const o1 = { id: 'o1', label: 'Ab', value: 'a' };
    const o2 = { id: 'o2', label: 'B', value: 'b' };
    expect(coalesceKey({ type: 'update_block', id: 'c', patch: { options: [o1, o2] } }, choice)).toBe('block:c:options.o1.label');
    expect(coalesceKey({ type: 'update_block', id: 'c', patch: { options: [o1] } }, choice)).toBeNull();
    expect(coalesceKey({ type: 'update_block', id: 'c', patch: { options: [o2, { ...o1, label: 'A' }] } }, choice)).toBeNull();
    expect(coalesceKey({ type: 'set_title', title: 'x' }, base)).toBe('title');
    expect(coalesceKey({ type: 'update_settings', patch: { themeColor: '#000000' } }, base)).toBe('settings:themeColor');
    expect(coalesceKey({ type: 'update_settings', patch: { progressBar: !base.settings.progressBar } }, base)).toBeNull();
    expect(coalesceKey({ type: 'delete_block', id: 'a', rules: 'disable' }, base)).toBeNull();
    expect(coalesceKey({ type: 'move_block', from: 0, to: 1 }, base)).toBeNull();
  });
});
