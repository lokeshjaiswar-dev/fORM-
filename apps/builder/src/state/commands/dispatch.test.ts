import { beforeEach, describe, expect, it } from 'vitest';
import type { BlockId, ChoiceOption, OptionId, PageId } from '@form/schema';
import { applyCommand, coalesceKey, dispatch } from '@/state/commands/dispatch';
import type { Command } from '@/state/commands/types';
import { useDocumentStore } from '@/state/documentStore';
import { block, counter, doc, formWith, resetStore } from '@/test/fixtures';
import { inlineDoc } from '@/lib/definition';

const id = (s: string) => s as BlockId;
const opts = (...labels: string[]): ChoiceOption[] => labels.map((label, i) => ({ id: `o${i + 1}` as OptionId, label }));

beforeEach(() => resetStore());

describe('applyCommand', () => {
  it('is pure: the input document is untouched and unchanged parts are shared', () => {
    const before = formWith([block('short_text', 'a', { label: 'A' }), block('short_text', 'b', { label: 'B' })]);
    const snapshot = structuredClone(before);
    const result = applyCommand(before, { type: 'update_block', id: id('a'), patch: { label: inlineDoc('A2') } });
    expect(result.ok).toBe(true);
    expect(before).toEqual(snapshot);
    if (!result.ok) return;
    expect(result.doc.blocks[id('a')]).toMatchObject({ label: inlineDoc('A2') });
    expect(result.doc.blocks[id('b')]).toBe(before.blocks[id('b')]);
    expect(result.doc.pages).toBe(before.pages);
    expect(result.doc.theme).toBe(before.theme);
  });

  it('takes new ids from the context, so a command list replays to the same document', () => {
    const base = formWith([block('multi_choice', 'a', { config: { display: 'checkbox', options: opts('O') } })]);
    const run = () => {
      const ids = counter('dup');
      const first = applyCommand(base, { type: 'duplicate_block', id: id('a') }, ids);
      if (!first.ok) throw new Error(first.error);
      return applyCommand(first.doc, { type: 'duplicate_block', id: id('a') }, ids);
    };
    expect(run()).toEqual(run());
    const result = run();
    expect(result.ok && result.doc.pages[0]?.children).toEqual(['a', 'dup_2', 'dup_1']);
    expect(result.ok && result.doc.blocks[id('dup_1')]).toMatchObject({ key: 'a_2', config: { options: [{ id: 'o1' }] } });
  });

  it('a top-level undefined in a patch unsets that part of the block; nested undefined values are dropped', () => {
    const base = formWith([block('short_text', 'a', { hideLabel: true, config: { placeholder: 'x', minLength: 2 } })]);
    const result = applyCommand(base, { type: 'update_block', id: id('a'), patch: { hideLabel: undefined, config: { placeholder: undefined, minLength: 2 } } });
    expect(result.ok && result.doc.blocks[id('a')]).not.toHaveProperty('hideLabel');
    expect(result.ok && result.doc.blocks[id('a')]).toMatchObject({ config: { minLength: 2 } });
    expect(result.ok && (result.doc.blocks[id('a')] as { config: object }).config).not.toHaveProperty('placeholder');
  });

  it.each<[string, Command]>([
    ['an unknown block key', { type: 'update_block', id: id('a'), patch: { colour: 'red' } }],
    ['a wrong value type', { type: 'update_block', id: id('a'), patch: { label: 'plain text' } }],
    ['a type change', { type: 'update_block', id: id('a'), patch: { type: 'email' } }],
    ['unsetting the label', { type: 'update_block', id: id('a'), patch: { label: undefined } }],
    ['a config the type rejects', { type: 'update_block', id: id('a'), patch: { config: { maxLength: -1 } } }],
    ['a key that is taken', { type: 'update_block', id: id('a'), patch: { key: 'b' } }],
    ['a key that is not a key', { type: 'update_block', id: id('a'), patch: { key: 'Not A Key' } }],
    ['a missing block', { type: 'delete_block', id: id('nope'), rules: 'disable' }],
    ['a duplicate block id', { type: 'apply_ops', ops: [{ op: 'add_block', block: block('short_text', 'a', { key: 'other' }), parent: { pageId: 'page_1' as PageId }, index: 0 }] }],
    ['a duplicate key', { type: 'apply_ops', ops: [{ op: 'add_block', block: block('short_text', 'z', { key: 'a' }), parent: { pageId: 'page_1' as PageId }, index: 0 }] }],
    ['a page that does not exist', { type: 'paste_block', block: block('short_text', 'z'), at: { pageId: 'nope' as PageId, index: 0 } }],
    ['a move out of range', { type: 'move_block', id: id('a'), to: { pageId: 'page_1' as PageId, index: 2 } }],
    ['merging the first page', { type: 'merge_page', pageId: 'page_1' as PageId }],
    ['an unknown theme key', { type: 'set_theme', theme: { ...formWith([]).theme, dark: true } as never }],
    ['another document', { type: 'replace_document', doc: { ...formWith([]), formId: 'other' as never } }],
    ['an unknown command', { type: 'rename_form' } as unknown as Command],
  ])('rejects %s and changes nothing', (_, command) => {
    resetStore([block('short_text', 'a'), block('short_text', 'b')]);
    const before = doc();
    const result = dispatch(command);
    expect(result.ok).toBe(false);
    expect(doc()).toBe(before);
    expect(useDocumentStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('a command that changes nothing adds no history', () => {
    resetStore([block('short_text', 'a', { label: 'Same' })]);
    const before = doc();
    expect(dispatch({ type: 'update_block', id: id('a'), patch: { label: inlineDoc('Same') } }).ok).toBe(true);
    expect(doc()).toBe(before);
    expect(useDocumentStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('typing commands coalesce per (block, leaf path) or form part; toggles and structural commands never do', () => {
    const base = formWith([block('short_text', 'a', { config: { prefix: 'a' } })]);
    const a = base.blocks[id('a')] as unknown as { config: Record<string, unknown> };
    expect(coalesceKey({ type: 'update_block', id: id('a'), patch: { label: inlineDoc('x') } }, base)).toBe('block:a:label');
    expect(coalesceKey({ type: 'update_block', id: id('a'), patch: { label: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }] }, { type: 'text', text: 'y' }] }] } } }, base)).toBe('block:a:label');
    expect(coalesceKey({ type: 'update_block', id: id('a'), patch: { config: { ...a.config, prefix: '$' } } }, base)).toBe('block:a:config.prefix');
    expect(coalesceKey({ type: 'update_block', id: id('a'), patch: { config: { ...a.config, suffix: 'kg' } } }, base)).toBe('block:a:config.suffix');
    expect(coalesceKey({ type: 'update_block', id: id('a'), patch: { hideLabel: true } }, base)).toBeNull();
    expect(coalesceKey({ type: 'update_block', id: id('a'), patch: { required: false } }, base)).toBeNull();
    const choice = formWith([block('single_choice', 'c', { config: { display: 'radio', options: opts('A', 'B') } })]);
    const [o1, o2] = opts('A', 'B') as [ChoiceOption, ChoiceOption];
    const config = (options: ChoiceOption[]) => ({ config: { display: 'radio', options } });
    expect(coalesceKey({ type: 'update_block', id: id('c'), patch: config([{ ...o1, label: 'Ab' }, o2]) }, choice)).toBe('block:c:config.options.o1.label');
    expect(coalesceKey({ type: 'update_block', id: id('c'), patch: config([o1]) }, choice)).toBeNull();
    expect(coalesceKey({ type: 'update_block', id: id('c'), patch: config([o2, o1]) }, choice)).toBeNull();
    expect(coalesceKey({ type: 'set_title', title: 'x' }, base)).toBe('title');
    expect(coalesceKey({ type: 'set_theme', theme: { ...base.theme, tokens: { ...base.theme.tokens, colors: { accent: '#000000' as never } } } }, base)).toBe('theme:tokens.colors.accent');
    expect(coalesceKey({ type: 'set_behavior', behavior: { ...base.behavior, successAnimation: !base.behavior.successAnimation } }, base)).toBeNull();
    expect(coalesceKey({ type: 'delete_block', id: id('a'), rules: 'disable' }, base)).toBeNull();
    expect(coalesceKey({ type: 'move_block', id: id('a'), to: { pageId: 'page_1' as PageId, index: 0 } }, base)).toBeNull();
  });
});
