import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addBlock, deleteBlock, duplicateBlock, moveBlock, placeBeside, replaceDocument, requestDeleteBlock, setBlockWidth, setTitle, updateBlock,
} from '@/state/actions';
import { useDocumentStore } from '@/state/documentStore';
import { redo, undo } from '@/state/history';
import { useUiStore } from '@/state/uiStore';
import { block, blockIds, doc, formWith, resetStore } from '@/test/fixtures';

const ui = () => useUiStore.getState();
const history = () => useDocumentStore.temporal.getState();

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('builder actions', () => {
  it('addBlock inserts at an index, reindexes order and selects the new block', () => {
    resetStore([block('text', { id: 'a' }), block('text', { id: 'b' })]);
    const id = addBlock('email', 1);
    expect(blockIds()).toEqual(['a', id, 'b']);
    expect(doc().blocks.map((b) => b.order)).toEqual([0, 1, 2]);
    expect(ui().activeBlockId).toBe(id);
  });

  it('deleteBlock removes the block and closes the inspector if it was active', () => {
    resetStore([block('text', { id: 'a' }), block('text', { id: 'b' })]);
    ui().openInspector('a');
    deleteBlock('a');
    expect(blockIds()).toEqual(['b']);
    expect(ui().activeBlockId).toBeNull();
    expect(ui().inspectorOpen).toBe(false);
  });

  it('placeBeside makes the host and the new block half width', () => {
    resetStore([block('text', { id: 'a' })]);
    placeBeside('a', { type: 'email' });
    const [host, beside] = doc().blocks;
    expect(host.customize).toMatchObject({ width: 'half', besidePrevious: false });
    expect(beside.customize).toMatchObject({ width: 'half', besidePrevious: true });
    expect(ui().activeBlockId).toBe(beside.id);
  });

  it('moveBlock moves a block and unpairs it', () => {
    resetStore([
      block('text', { id: 'a', customize: { width: 'half' } }),
      block('text', { id: 'b', customize: { width: 'half', besidePrevious: true } }),
      block('text', { id: 'c' }),
    ]);
    moveBlock(1, 2);
    expect(blockIds()).toEqual(['a', 'c', 'b']);
    expect(doc().blocks[2].customize?.besidePrevious).toBe(false);
  });

  it('full width unpairs the block beside it in one undo step', () => {
    resetStore([
      block('text', { id: 'a', customize: { width: 'half' } }),
      block('text', { id: 'b', customize: { width: 'half', besidePrevious: true } }),
    ]);
    setBlockWidth('a', 'full');
    expect(doc().blocks.map((b) => b.customize)).toEqual([
      { width: 'full', besidePrevious: false },
      { width: 'half', besidePrevious: false },
    ]);
    undo();
    expect(doc().blocks[1].customize?.besidePrevious).toBe(true);
  });

  it('replaceDocument loads a template under the open form id, as one undoable step', () => {
    resetStore([block('text', { id: 'a' })]);
    replaceDocument({ ...formWith([block('email', { id: 'mail' })]), id: 'template', title: 'From a template' });
    expect(doc()).toMatchObject({ id: 'test', title: 'From a template' });
    expect(blockIds()).toEqual(['mail']);
    undo();
    expect(blockIds()).toEqual(['a']);
  });

  it('B17: selecting blocks and other UI changes add no undo history', () => {
    const id = addBlock('text');
    history().clear();
    for (let i = 0; i < 10; i++) ui().setActiveBlock(i % 2 ? id : null);
    ui().openInspector(id);
    ui().setSidebarOpen(true);
    ui().setInspectorWidth(500);
    ui().requestInsertFocus();
    ui().startBlank();
    expect(history().pastStates).toHaveLength(0);
  });

  it('B18: a structural change right after typing can be undone', () => {
    const id = addBlock('text');
    updateBlock(id, { label: 'Name' });
    deleteBlock(id);
    vi.advanceTimersByTime(1000);
    undo();
    expect(blockIds()).toEqual([id]);
    expect(doc().blocks[0].label).toBe('Name');
  });

  it('B19: moveBlock and placeBeside leave the previous document untouched', () => {
    resetStore([
      block('text', { id: 'a', customize: { width: 'half' } }),
      block('text', { id: 'b', customize: { width: 'half', besidePrevious: true } }),
      block('text', { id: 'c' }),
    ]);
    const before = doc();
    moveBlock(1, 2);
    expect(before.blocks[1].customize?.besidePrevious).toBe(true);
    const middle = doc();
    placeBeside('a', { id: 'b' });
    expect(middle.blocks[2].customize).toEqual({ width: 'half', besidePrevious: false });
    expect(doc().blocks[1]).toMatchObject({ id: 'b', customize: { width: 'half', besidePrevious: true } });
  });

  it('B20: duplicate is a deep copy with fresh block and option ids, no rule and no origin', () => {
    const source = block('dropdown', {
      id: 'a',
      options: [{ id: 'o1', label: 'One', value: 'one' }],
      validation: { required: true },
      customize: { prefix: 'x' },
      logic: { enabled: true, action: 'show', sourceBlockId: 'q', value: 'yes' },
    });
    resetStore([block('text', { id: 'q' }), { ...source, origin: { templateId: 't' } } as typeof source]);
    duplicateBlock('a');
    const [, original, copy] = doc().blocks;
    expect(copy.id).not.toBe('a');
    expect(ui().activeBlockId).toBe(copy.id);
    expect(copy.options?.[0]).toMatchObject({ label: 'One', value: 'one' });
    expect(copy.options?.[0].id).not.toBe('o1');
    expect(copy).not.toHaveProperty('logic');
    expect(copy).not.toHaveProperty('origin');
    expect(copy.validation).toEqual(original.validation);
    expect(copy.validation).not.toBe(original.validation);
    expect(copy.customize).not.toBe(original.customize);
    expect(copy.options).not.toBe(original.options);
    expect(original.logic?.enabled).toBe(true);
  });

  it('B20: a copy of a paired block is full width and goes after the pair, which stays whole', () => {
    const half = { width: 'half' as const };
    resetStore([block('text', { id: 'a', customize: half }), block('text', { id: 'b', customize: { ...half, besidePrevious: true } }), block('text', { id: 'c' })]);
    duplicateBlock('a');
    const copy = doc().blocks[2];
    expect(blockIds()).toEqual(['a', 'b', copy.id, 'c']);
    expect(copy.customize).toMatchObject({ width: 'full', besidePrevious: false });
    expect(doc().blocks[1].customize?.besidePrevious).toBe(true);
    duplicateBlock('b');
    expect(doc().blocks[2].customize).toMatchObject({ width: 'full', besidePrevious: false });
    expect(doc().blocks.filter((b) => b.customize?.besidePrevious).map((b) => b.id)).toEqual(['b']);
  });

  it('placeBeside unpairs the old partners of the host and of the moved block, and never pairs a block with itself', () => {
    const half = { width: 'half' as const };
    resetStore([
      block('text', { id: 'a', customize: half }),
      block('text', { id: 'b', customize: { ...half, besidePrevious: true } }),
      block('text', { id: 'c', customize: half }),
      block('text', { id: 'd', customize: { ...half, besidePrevious: true } }),
    ]);
    placeBeside('a', { id: 'c' });
    expect(blockIds()).toEqual(['a', 'c', 'b', 'd']);
    expect(doc().blocks.map((b) => b.customize?.besidePrevious ?? false)).toEqual([false, true, false, false]);
    const before = doc();
    const depth = history().pastStates.length;
    expect(placeBeside('a', { id: 'a' })).toMatchObject({ ok: false });
    expect(doc()).toBe(before);
    expect(history().pastStates).toHaveLength(depth);
  });

  it('B21: deleting a logic source leaves no dangling rule', () => {
    resetStore([
      block('text', { id: 'src' }),
      block('text', { id: 'target', logic: { enabled: true, action: 'show', sourceBlockId: 'src', value: 'yes' } }),
    ]);
    deleteBlock('src');
    const dangling = doc().blocks.filter((b) => b.logic?.enabled && b.logic.sourceBlockId === 'src');
    expect(dangling).toEqual([]);
  });

  it('B21: delete asks first when rules read the block, then removes or disables them', () => {
    const rule = { enabled: true, action: 'show' as const, sourceBlockId: 'src', value: 'yes' };
    resetStore([block('text', { id: 'src' }), block('text', { id: 't1', logic: rule }), block('text', { id: 't2', logic: rule })]);
    requestDeleteBlock('src');
    expect(blockIds()).toEqual(['src', 't1', 't2']);
    expect(ui().pendingDelete).toBe('src');

    deleteBlock('src', 'disable');
    expect(ui().pendingDelete).toBeNull();
    expect(doc().blocks.map((b) => b.logic)).toEqual([{ ...rule, enabled: false }, { ...rule, enabled: false }]);

    undo();
    deleteBlock('src', 'remove');
    expect(doc().blocks.map((b) => b.logic)).toEqual([undefined, undefined]);

    resetStore([block('text', { id: 'lonely' })]);
    requestDeleteBlock('lonely');
    expect(blockIds()).toEqual([]);
  });

  it('undo and redo restore the document and not the selection', () => {
    const id = addBlock('text');
    setTitle('Title');
    undo();
    expect(doc().title).toBe('Test form');
    undo();
    expect(blockIds()).toEqual([]);
    expect(ui().activeBlockId).toBe(id);
    redo();
    redo();
    expect(blockIds()).toEqual([id]);
    expect(doc().title).toBe('Title');
  });
});
