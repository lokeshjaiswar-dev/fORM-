import type { Tile } from '@/fields/tiles';
import { inlineDoc } from '@/lib/definition';
import { addBlock, insertPageBreak } from '@/state/actions';
import type { PageSlot } from '@/state/commands/types';

/** Inserts what a palette or slash-menu tile names at `at`: a block for a registry entry, or a page break. */
export function insertTile(tile: Tile, at?: PageSlot): void {
  if (tile.kind === 'page_break') insertPageBreak(at);
  else {
    const content = tile.choice.type === 'heading' || tile.choice.type === 'paragraph' || tile.choice.type === 'divider';
    addBlock(tile.choice, at, content ? {} : { label: inlineDoc(tile.label) });
  }
}
