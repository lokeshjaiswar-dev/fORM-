import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockId, DocumentOp, IsoInstant, OptionId, PageId, StoredBlock } from '@form/schema';
import {
  addBlock, copyBlock, deleteBlock, duplicateBlock, insertPageBreak, moveBlock, pasteBlock, placeBeside, removePageBreak, removeRule, replaceDocument,
  requestDeleteBlock, setBlockWidth, setRule, setTitle, updateBlock,
} from '@/state/actions';
import { dispatch } from '@/state/commands/dispatch';
import { useDocumentStore } from '@/state/documentStore';
import { redo, undo } from '@/state/history';
import { useUiStore } from '@/state/uiStore';
import { inlineDoc } from '@/lib/definition';
import { previewVersion } from '@/lib/preview';
import { PURPOSE, block, blockIds, doc, formWith, keyOf, resetStore, rule, text } from '@/test/fixtures';

const ui = () => useUiStore.getState();
const history = () => useDocumentStore.temporal.getState();
const id = (s: string) => s as BlockId;
const get = (s: string): StoredBlock => doc().blocks[id(s)] as StoredBlock;
const layout = (s: string) => (get(s) as { layout?: unknown }).layout;
const SHORT = { type: 'short_text', configOverrides: {} } as const;

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('builder actions', () => {
  it('addBlock inserts a registry block at a page position, with a fresh key and the form purpose, and selects it', () => {
    resetStore([block('short_text', 'a'), block('short_text', 'b')]);
    const added = addBlock({ type: 'email', configOverrides: {} }, { pageId: 'page_1' as PageId, index: 1 });
    expect(blockIds()).toEqual(['a', added, 'b']);
    expect(get(added)).toMatchObject({ type: 'email', key: 'email', required: false, compliance: { classification: 'personal', purposeIds: [PURPOSE] } });
    expect(ui().activeBlockId).toBe(added);
    expect(keyOf(get(addBlock(SHORT)))).toBe('short_text');
    expect(keyOf(get(addBlock(SHORT)))).toBe('short_text_2');
  });

  it('a palette entry brings its config overrides (FND-03)', () => {
    const dropdown = addBlock({ type: 'single_choice', configOverrides: { display: 'dropdown' } });
    expect(get(dropdown)).toMatchObject({ config: { display: 'dropdown', options: [{ id: 'option_1' }, { id: 'option_2' }, { id: 'option_3' }] } });
  });

  it('a form without a purpose gets the default one with its first field (I7)', () => {
    resetStore();
    useDocumentStore.setState({ doc: { ...doc(), privacy: { ...doc().privacy, purposes: [] } } });
    const added = addBlock(SHORT);
    expect(doc().privacy.purposes).toHaveLength(1);
    expect(get(added)).toMatchObject({ compliance: { purposeIds: [doc().privacy.purposes[0]?.id] } });
  });

  it('a field placed beside another on a form without a purpose gets the default one in the same step (I7)', () => {
    resetStore([block('heading', 'a')]);
    useDocumentStore.setState({ doc: { ...doc(), privacy: { ...doc().privacy, purposes: [] } } });
    expect(placeBeside(id('a'), { choice: SHORT })).toMatchObject({ ok: true });
    expect(doc().privacy.purposes).toHaveLength(1);
    expect(get(blockIds()[1] ?? '')).toMatchObject({ compliance: { purposeIds: [doc().privacy.purposes[0]?.id] } });
  });

  it('a field pasted into a form without a purpose gets the default one in the same step (I7)', () => {
    resetStore([block('heading', 'h')]);
    useDocumentStore.setState({ doc: { ...doc(), privacy: { ...doc().privacy, purposes: [] } } });
    useUiStore.setState({ clipboard: block('email', 'mail') });
    expect(pasteBlock()).toMatchObject({ ok: true });
    const [purpose] = doc().privacy.purposes;
    expect(purpose).toBeDefined();
    expect(get(blockIds()[1] ?? '')).toMatchObject({ compliance: { purposeIds: [purpose?.id] } });
    undo();
    expect(doc().privacy.purposes).toEqual([]);
    expect(blockIds()).toEqual(['h']);
  });

  it('removing an option takes it out of the rules that named it; a rule left with none is disabled (B21)', () => {
    const opts = { options: [{ id: 'o1' as OptionId, label: 'One' }, { id: 'o2' as OptionId, label: 'Two' }, { id: 'o3' as OptionId, label: 'Three' }] };
    const options = (ids: string[]) => ({ kind: 'options', blockId: id('pick'), optionIds: ids as OptionId[] }) as const;
    resetStore(
      [block('multi_choice', 'pick', { config: opts }), block('short_text', 'a'), block('short_text', 'b')],
      [rule('r1', 'pick', 'includes_any', options(['o1', 'o2']), 'show', ['a']), rule('r2', 'pick', 'includes_any', options(['o2']), 'show', ['b'])],
    );
    useDocumentStore.setState({ doc: { ...doc(), blocks: { ...doc().blocks, [id('a')]: { ...get('a'), initiallyHidden: true }, [id('b')]: { ...get('b'), initiallyHidden: true } } as never } });
    const config = (get('pick') as { config: typeof opts }).config;
    updateBlock(id('pick'), { config: { ...config, options: config.options.filter((o) => o.id !== 'o2') } });
    const [r1, r2] = doc().logic.rules;
    expect(r1).toMatchObject({ enabled: true, when: { children: [{ right: { optionIds: ['o1'] } }] } });
    expect(r2).toMatchObject({ enabled: false, when: { children: [{ right: { optionIds: [] } }] } });
    expect(get('a')).toHaveProperty('initiallyHidden', true);
    expect(get('b')).not.toHaveProperty('initiallyHidden');
    expect(previewVersion(doc(), { state: 'open' }, '2026-10-18T10:00:00.000Z' as IsoInstant)).toMatchObject({ ok: true });
    undo();
    expect(doc().logic.rules.map((r) => [r.enabled, r.when.children[0]])).toMatchObject([[true, { right: { optionIds: ['o1', 'o2'] } }], [true, { right: { optionIds: ['o2'] } }]]);
  });

  it('deleteBlock removes the block and closes the inspector if it was active', () => {
    resetStore([block('short_text', 'a'), block('short_text', 'b')]);
    ui().openInspector(id('a'));
    deleteBlock(id('a'));
    expect(blockIds()).toEqual(['b']);
    expect(doc().blocks).not.toHaveProperty('a');
    expect(ui().activeBlockId).toBeNull();
    expect(ui().inspectorOpen).toBe(false);
  });

  it('placeBeside makes the host and the new block half width, the new one joining the host row', () => {
    resetStore([block('short_text', 'a')]);
    placeBeside(id('a'), { choice: { type: 'email', configOverrides: {} } });
    const [, beside] = blockIds();
    expect(layout('a')).toEqual({ width: 'half', startNewRow: true });
    expect(layout(beside ?? '')).toEqual({ width: 'half' });
    expect(ui().activeBlockId).toBe(beside);
  });

  it('moveBlock moves a block (across pages too) and unpairs it', () => {
    resetStore([
      [block('short_text', 'a', { layout: { width: 'half', startNewRow: true } }), block('short_text', 'b', { layout: { width: 'half' } }), block('short_text', 'c')],
      [block('short_text', 'd')],
    ]);
    moveBlock(id('b'), { pageId: 'page_1' as PageId, index: 2 });
    expect(doc().pages[0]?.children).toEqual(['a', 'c', 'b']);
    expect(layout('b')).toEqual({ width: 'half', startNewRow: true });
    moveBlock(id('a'), { pageId: 'page_2' as PageId, index: 0 });
    expect(doc().pages.map((p) => p.children)).toEqual([['c', 'b'], ['a', 'd']]);
  });

  it('full width unpairs the block beside it in one undo step', () => {
    resetStore([block('short_text', 'a', { layout: { width: 'half', startNewRow: true } }), block('short_text', 'b', { layout: { width: 'half' } })]);
    setBlockWidth(id('a'), 'full');
    expect(layout('a')).toBeUndefined();
    expect(layout('b')).toEqual({ width: 'half', startNewRow: true });
    undo();
    expect(layout('b')).toEqual({ width: 'half' });
  });

  it('BL-150: deleting the first block of a pair leaves the second on its own row', () => {
    resetStore([
      block('short_text', 'x', { layout: { width: 'half', startNewRow: true } }),
      block('short_text', 'a', { layout: { width: 'half', startNewRow: true } }),
      block('short_text', 'b', { layout: { width: 'half' } }),
    ]);
    deleteBlock(id('a'));
    expect(layout('b')).toEqual({ width: 'half', startNewRow: true });
  });

  it('replaceDocument loads a template under the open form id, as one undoable step', () => {
    resetStore([block('short_text', 'a')]);
    replaceDocument({ ...formWith([block('email', 'mail')]), formId: 'template' as never, title: 'From a template' });
    expect(doc()).toMatchObject({ formId: 'test', title: 'From a template' });
    expect(blockIds()).toEqual(['mail']);
    undo();
    expect(blockIds()).toEqual(['a']);
  });

  it('page breaks split a page and merge it back', () => {
    resetStore([block('short_text', 'a'), block('short_text', 'b')]);
    insertPageBreak({ pageId: 'page_1' as PageId, index: 1 });
    expect(doc().pages.map((p) => p.children)).toEqual([['a'], ['b']]);
    const second = doc().pages[1]?.id as PageId;
    removePageBreak(second);
    expect(doc().pages.map((p) => p.children)).toEqual([['a', 'b']]);
    undo();
    expect(doc().pages).toHaveLength(2);
  });

  it('B17: selecting blocks and other UI changes add no undo history', () => {
    const added = addBlock(SHORT) as BlockId;
    history().clear();
    for (let i = 0; i < 10; i++) ui().setActiveBlock(i % 2 ? added : null);
    ui().openInspector(added);
    ui().setSidebarOpen(true);
    ui().setInspectorWidth(500);
    ui().requestInsertFocus();
    ui().startBlank();
    copyBlock(added);
    expect(history().pastStates).toHaveLength(0);
  });

  it('B18: a structural change right after typing can be undone', () => {
    const added = addBlock(SHORT) as BlockId;
    updateBlock(added, { label: inlineDoc('Name') });
    deleteBlock(added);
    vi.advanceTimersByTime(1000);
    undo();
    expect(blockIds()).toEqual([added]);
    expect(get(added)).toMatchObject({ label: inlineDoc('Name') });
  });

  it('B19: moveBlock and placeBeside leave the previous document untouched', () => {
    resetStore([block('short_text', 'a', { layout: { width: 'half', startNewRow: true } }), block('short_text', 'b', { layout: { width: 'half' } }), block('short_text', 'c')]);
    const before = doc();
    moveBlock(id('b'), { pageId: 'page_1' as PageId, index: 2 });
    expect((before.blocks[id('b')] as { layout?: unknown }).layout).toEqual({ width: 'half' });
    expect(before.pages[0]?.children).toEqual(['a', 'b', 'c']);
    const middle = doc();
    placeBeside(id('a'), { id: id('b') });
    expect((middle.blocks[id('b')] as { layout?: unknown }).layout).toEqual({ width: 'half', startNewRow: true });
    expect(doc().pages[0]?.children).toEqual(['a', 'b', 'c']);
    expect(layout('b')).toEqual({ width: 'half' });
  });

  it('B20: duplicate is a deep copy with a fresh id and key, no rule, no origin and not hidden', () => {
    const source = block('single_choice', 'a', {
      label: 'Colour',
      config: { display: 'radio', options: [{ id: 'o1' as OptionId, label: 'One', code: 'one' }] },
      required: true,
      style: { labelColor: '#111111' },
      origin: { bindingId: 'binding', sourceId: 'src' },
      initiallyHidden: true,
    });
    resetStore([block('short_text', 'q'), source], [rule('r1', 'q', 'eq', text('yes'), 'show', ['a'])]);
    expect(get('a')).toMatchObject({ initiallyHidden: true });
    duplicateBlock(id('a'));
    const copyId = blockIds()[2] as string;
    const copy = get(copyId) as typeof source;
    const original = get('a') as typeof source;
    expect(copyId).not.toBe('a');
    expect(ui().activeBlockId).toBe(copyId);
    expect(copy).toMatchObject({ key: 'a_2', required: true, label: inlineDoc('Colour'), config: { options: [{ id: 'o1', label: 'One', code: 'one' }] } });
    expect(copy).not.toHaveProperty('origin');
    expect(copy).not.toHaveProperty('initiallyHidden');
    expect(doc().logic.rules.flatMap((r) => r.then.flatMap((a) => ('targets' in a ? a.targets : [])))).toEqual(['a']);
    expect(copy.config).not.toBe(original.config);
    expect(copy.style).not.toBe(original.style);
  });

  it('B20: a copy of a paired block starts its own row and goes after the pair, which stays whole', () => {
    resetStore([block('short_text', 'a', { layout: { width: 'half', startNewRow: true } }), block('short_text', 'b', { layout: { width: 'half' } }), block('short_text', 'c')]);
    duplicateBlock(id('a'));
    const copy = blockIds()[2] as string;
    expect(blockIds()).toEqual(['a', 'b', copy, 'c']);
    expect(layout(copy)).toEqual({ width: 'half', startNewRow: true });
    expect(layout('b')).toEqual({ width: 'half' });
  });

  it('placeBeside unpairs the old partners of the host and of the moved block, and never pairs a block with itself', () => {
    const half = { width: 'half' as const };
    resetStore([
      block('short_text', 'a', { layout: { ...half, startNewRow: true } }),
      block('short_text', 'b', { layout: half }),
      block('short_text', 'c', { layout: { ...half, startNewRow: true } }),
      block('short_text', 'd', { layout: half }),
    ]);
    placeBeside(id('a'), { id: id('c') });
    expect(blockIds()).toEqual(['a', 'c', 'b', 'd']);
    expect(['a', 'c', 'b', 'd'].map(layout)).toEqual([{ ...half, startNewRow: true }, half, { ...half, startNewRow: true }, { ...half, startNewRow: true }]);
    const before = doc();
    const depth = history().pastStates.length;
    expect(placeBeside(id('a'), { id: id('a') })).toMatchObject({ ok: false });
    expect(doc()).toBe(before);
    expect(history().pastStates).toHaveLength(depth);
  });

  it('B21: deleting a logic source leaves no dangling rule', () => {
    resetStore([block('short_text', 'src'), block('short_text', 'target')], [rule('r1', 'src', 'eq', text('yes'), 'show', ['target'])]);
    deleteBlock(id('src'));
    expect(doc().logic.rules.filter((r) => r.enabled)).toEqual([]);
  });

  it('B21: delete asks first when rules read the block, then removes or disables them', () => {
    const rules = [rule('r1', 'src', 'eq', text('yes'), 'show', ['t1']), rule('r2', 'src', 'eq', text('yes'), 'show', ['t2'])];
    resetStore([block('short_text', 'src'), block('short_text', 't1'), block('short_text', 't2')], rules);
    requestDeleteBlock(id('src'));
    expect(blockIds()).toEqual(['src', 't1', 't2']);
    expect(ui().pendingDelete).toBe('src');

    deleteBlock(id('src'), 'disable');
    expect(ui().pendingDelete).toBeNull();
    expect(doc().logic.rules.map((r) => r.enabled)).toEqual([false, false]);
    expect(get('t1')).not.toHaveProperty('initiallyHidden');

    undo();
    deleteBlock(id('src'), 'remove');
    expect(doc().logic.rules).toEqual([]);

    resetStore([block('short_text', 'lonely')]);
    requestDeleteBlock(id('lonely'));
    expect(blockIds()).toEqual([]);
  });

  it('deleting a rule target drops it from the rule; a rule left with no action goes', () => {
    resetStore([block('short_text', 'src'), block('short_text', 't1'), block('short_text', 't2')], [rule('r1', 'src', 'is_answered', undefined, 'show', ['t1', 't2'])]);
    deleteBlock(id('t1'));
    expect(doc().logic.rules[0]?.then).toEqual([{ type: 'show', targets: ['t2'] }]);
    deleteBlock(id('t2'));
    expect(doc().logic.rules).toEqual([]);
  });

  it('D2: a show rule hides its target until it matches; removing the rule clears it', () => {
    resetStore([block('short_text', 'src'), block('short_text', 'target')]);
    setRule(rule('r1', 'src', 'eq', text('yes'), 'show', ['target']));
    expect(get('target')).toMatchObject({ initiallyHidden: true });
    setRule(rule('r1', 'src', 'eq', text('yes'), 'hide', ['target']));
    expect(get('target')).not.toHaveProperty('initiallyHidden');
    setRule(rule('r1', 'src', 'eq', text('yes'), 'show', ['target'], false));
    expect(get('target')).not.toHaveProperty('initiallyHidden');
    setRule(rule('r1', 'src', 'eq', text('yes'), 'show', ['target']));
    removeRule('r1' as never);
    expect(get('target')).not.toHaveProperty('initiallyHidden');
  });

  it('BL-144: copy and paste make a fresh block after the selection: new id and key, no origin, no rules', () => {
    resetStore(
      [block('short_text', 'src'), block('short_text', 'a', { label: 'Name', origin: { bindingId: 'binding', sourceId: 'name' } }), block('short_text', 'b')],
      [rule('r1', 'src', 'eq', text('yes'), 'show', ['a'])],
    );
    expect(copyBlock(id('a'))).toBe(true);
    updateBlock(id('a'), { label: inlineDoc('Changed after copy') });
    ui().setActiveBlock(id('b'));
    const result = pasteBlock();
    expect(result.ok).toBe(true);
    const pasted = blockIds()[3] as string;
    expect(blockIds()).toEqual(['src', 'a', 'b', pasted]);
    expect(get(pasted)).toMatchObject({ type: 'short_text', key: 'a_2', label: inlineDoc('Name') });
    expect(get(pasted)).not.toHaveProperty('origin');
    expect(get(pasted)).not.toHaveProperty('initiallyHidden');
    expect(doc().logic.rules).toHaveLength(1);
    expect(ui().activeBlockId).toBe(pasted);
    pasteBlock();
    expect(keyOf(get(blockIds()[4] as string))).toBe('a_3');
    undo();
    undo();
    expect(blockIds()).toEqual(['src', 'a', 'b']);
  });

  it('BL-144: a block copied in another form takes this form purposes when pasted', () => {
    resetStore([block('short_text', 'a')]);
    const foreign = block('email', 'mail', { compliance: { classification: 'personal', category: 'contact', purposeIds: ['elsewhere'], encrypt: false, allowPrefill: true, inNotifications: 'include', inExports: 'include' } });
    useUiStore.setState({ clipboard: foreign });
    pasteBlock();
    expect(get(blockIds()[1] as string)).toMatchObject({ type: 'email', compliance: { purposeIds: [PURPOSE] } });
  });

  it('BL-085: snippet DocumentOps apply as one undoable step, a container keeping the children it lists', () => {
    resetStore([block('short_text', 'a')]);
    const child1 = block('short_text', 'pan', { label: 'PAN' });
    const child2 = block('email', 'pan_email', { label: 'Email' });
    const section = { id: id('kyc'), type: 'section', config: { children: [id('pan'), id('pan_email')], collapsible: false } } as StoredBlock;
    const ops = [
      { op: 'add_block', block: section, parent: { pageId: 'page_1' }, index: 1 },
      { op: 'add_block', block: child1, parent: { blockId: 'kyc' }, index: 0 },
      { op: 'add_block', block: child2, parent: { blockId: 'kyc' }, index: 1 },
      { op: 'add_rule', rule: rule('kyc_rule', 'pan', 'is_answered', undefined, 'show', ['pan_email']), index: 0 },
    ] as unknown as DocumentOp[];
    const before = doc();
    expect(dispatch({ type: 'apply_ops', ops }).ok).toBe(true);
    expect(blockIds()).toEqual(['a', 'kyc', 'pan', 'pan_email']);
    expect((get('kyc') as { config: { children: string[] } }).config.children).toEqual(['pan', 'pan_email']);
    expect(get('pan_email')).toMatchObject({ initiallyHidden: true });
    expect(history().pastStates).toHaveLength(1);
    const after = doc();
    undo();
    expect(doc()).toEqual(before);
    redo();
    expect(doc()).toEqual(after);
  });

  it('undo and redo restore the document and not the selection', () => {
    const added = addBlock(SHORT);
    setTitle('Title');
    undo();
    expect(doc().title).toBe('Test form');
    undo();
    expect(blockIds()).toEqual([]);
    expect(ui().activeBlockId).toBe(added);
    redo();
    redo();
    expect(blockIds()).toEqual([added]);
    expect(doc().title).toBe('Title');
  });
});
