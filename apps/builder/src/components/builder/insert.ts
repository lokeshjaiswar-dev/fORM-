import { REGISTRY } from '@form/registry';
import type { Tile } from '@/fields/tiles';
import { inlineDoc } from '@/lib/definition';
import { addBlock, addRepeatingGroup, insertPageBreak } from '@/state/actions';
import type { PageSlot } from '@/state/commands/types';

/** Inserts what a palette or slash-menu tile names at `at`: a block for a registry entry, or a page break. */
export function insertTile(tile: Tile, at?: PageSlot): void {
  if (tile.kind === 'page_break') insertPageBreak(at);
  else if (tile.choice.type === 'repeating_group') addRepeatingGroup(tile.choice, at);
  else {
    const kind = REGISTRY[tile.choice.type].kind;
    const content = kind === 'content' || kind === 'container' || kind === 'transient';
    const fillBlank = tile.choice.type === 'short_text' && tile.choice.configOverrides.placeholder === '_____';
    addBlock(tile.choice, at, content ? {} : { label: inlineDoc(tile.label), ...(fillBlank ? { hideLabel: true } : {}) });
  }
}
