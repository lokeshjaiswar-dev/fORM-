import { beforeEach, describe, expect, it } from 'vitest';
import type { BlockId, StoredBlock } from '@form/schema';
import { placeTileBeside } from '@/components/builder/insert';
import { TILES } from '@/fields/tiles';
import { inlineDoc } from '@/lib/definition';
import { useUiStore } from '@/state/uiStore';
import { block, blockIds, doc, resetStore } from '@/test/fixtures';

const tile = (id: string) => {
  const found = TILES.find((t) => t.id === id);
  if (!found) throw new Error(`no tile ${id}`);
  return found;
};

beforeEach(() => resetStore([block('short_text', 'host')]));

describe('placing a Toolbox field beside another', () => {
  it('names the new field after its tile, like a click or a normal drop does', () => {
    placeTileBeside('host' as BlockId, tile('email'));
    const [, placed] = blockIds();
    const made = doc().blocks[placed as BlockId] as StoredBlock & { label?: unknown };
    expect(made.type).toBe('email');
    expect(made.label).toEqual(inlineDoc('Email'));
    expect((made as { layout?: unknown }).layout).toEqual({ width: 'half' });
  });

  it('selects the new field and opens its settings', () => {
    placeTileBeside('host' as BlockId, tile('single_choice.dropdown'));
    const [, placed] = blockIds();
    expect(useUiStore.getState().activeBlockId).toBe(placed);
    expect(useUiStore.getState().inspectorOpen).toBe(true);
  });
});
