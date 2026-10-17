import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFormStore } from '@/store/useFormStore';
import { block, resetStore } from '@/test/fixtures';

const store = () => useFormStore.getState();
const history = () => useFormStore.temporal.getState();
const blockIds = () => store().form.blocks.map((b) => b.id);

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('useFormStore', () => {
  it('addBlock inserts at an index, reindexes order and selects the new block', () => {
    resetStore([block('text', { id: 'a' }), block('text', { id: 'b' })]);
    const id = store().addBlock('email', 1);
    expect(blockIds()).toEqual(['a', id, 'b']);
    expect(store().form.blocks.map((b) => b.order)).toEqual([0, 1, 2]);
    expect(store().activeBlockId).toBe(id);
  });

  it('duplicateBlock copies after the source with new block and option ids', () => {
    resetStore([block('dropdown', { id: 'a', options: [{ id: 'o1', label: 'One', value: 'one' }] })]);
    store().duplicateBlock('a');
    const [source, copy] = store().form.blocks;
    expect(copy.id).not.toBe('a');
    expect(copy.options?.[0]).toMatchObject({ label: 'One', value: 'one' });
    expect(copy.options?.[0].id).not.toBe('o1');
    expect(source.options?.[0].id).toBe('o1');
  });

  it('deleteBlock removes the block and closes the inspector if it was active', () => {
    resetStore([block('text', { id: 'a' }), block('text', { id: 'b' })]);
    store().openInspector('a');
    store().deleteBlock('a');
    expect(blockIds()).toEqual(['b']);
    expect(store().activeBlockId).toBeNull();
    expect(store().inspectorOpen).toBe(false);
  });

  it('placeBeside makes the host and the new block half width', () => {
    resetStore([block('text', { id: 'a' })]);
    store().placeBeside('a', { type: 'email' });
    const [host, beside] = store().form.blocks;
    expect(host.customize).toMatchObject({ width: 'half', besidePrevious: false });
    expect(beside.customize).toMatchObject({ width: 'half', besidePrevious: true });
  });

  it('reorderBlocks moves a block and unpairs it', () => {
    resetStore([
      block('text', { id: 'a', customize: { width: 'half' } }),
      block('text', { id: 'b', customize: { width: 'half', besidePrevious: true } }),
      block('text', { id: 'c' }),
    ]);
    store().reorderBlocks(1, 2);
    expect(blockIds()).toEqual(['a', 'c', 'b']);
    expect(store().form.blocks[2].customize?.besidePrevious).toBe(false);
  });

  it('undo and redo restore the form', () => {
    const id = store().addBlock('text');
    history().undo();
    expect(blockIds()).toEqual([]);
    history().redo();
    expect(blockIds()).toEqual([id]);
  });

  it('skips history while typing; the next change records the typed state', () => {
    const id = store().addBlock('text');
    history().clear();
    store().updateBlock(id, { label: 'N' });
    store().updateBlock(id, { label: 'Na' });
    vi.advanceTimersByTime(1000);
    expect(history().pastStates).toHaveLength(0);
    store().deleteBlock(id);
    expect(history().pastStates).toHaveLength(1);
    expect(history().pastStates[0].form?.blocks[0].label).toBe('Na');
  });

  it.fails('B17: selecting blocks adds no undo history', () => {
    const id = store().addBlock('text');
    history().clear();
    for (let i = 0; i < 10; i++) store().setActiveBlock(i % 2 ? id : null);
    expect(history().pastStates).toHaveLength(0);
  });

  it.fails('B18: a structural change right after typing can be undone', () => {
    const id = store().addBlock('text');
    store().updateBlock(id, { label: 'Name' });
    store().deleteBlock(id);
    vi.advanceTimersByTime(1000);
    history().undo();
    expect(blockIds()).toEqual([id]);
  });

  it.fails('B19: reorderBlocks does not mutate the previous state', () => {
    resetStore([
      block('text', { id: 'a', customize: { width: 'half' } }),
      block('text', { id: 'b', customize: { width: 'half', besidePrevious: true } }),
      block('text', { id: 'c' }),
    ]);
    const before = store().form;
    store().reorderBlocks(1, 2);
    expect(before.blocks[1].customize?.besidePrevious).toBe(true);
  });

  it.fails('B21: deleting a logic source leaves no dangling rule', () => {
    resetStore([
      block('text', { id: 'src' }),
      block('text', { id: 'target', logic: { enabled: true, action: 'show', sourceBlockId: 'src', value: 'yes' } }),
    ]);
    store().deleteBlock('src');
    const dangling = store().form.blocks.filter((b) => b.logic?.enabled && b.logic.sourceBlockId === 'src');
    expect(dangling).toEqual([]);
  });
});
