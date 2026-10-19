import type { Tile } from '@/fields/tiles';
import { addBlock, insertPageBreak } from '@/state/actions';
import type { PageSlot } from '@/state/commands/types';

/** Inserts what a palette or slash-menu tile names at `at`: a block for a registry entry, or a page break. */
export function insertTile(tile: Tile, at?: PageSlot): void {
  if (tile.kind === 'page_break') insertPageBreak(at);
  else addBlock(tile.choice, at);
}
