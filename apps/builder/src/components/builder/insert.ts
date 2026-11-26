import { REGISTRY } from '@form/registry';
import type { BlockId } from '@form/schema';
import type { Tile } from '@/fields/tiles';
import { inlineDoc, placementOf } from '@/lib/definition';
import { addBlock, addRepeatingGroup, insertPageBreak, placeBeside } from '@/state/actions';
import { currentDoc } from '@/state/documentStore';
import type { BlockPatch, PageSlot } from '@/state/commands/types';

/** Inserts what a palette or slash-menu tile names at `at`: a block for a registry entry, or a page break. */
export function insertTile(tile: Tile, at?: PageSlot): void {
  if (tile.kind === 'page_break') insertPageBreak(at);
  else if (tile.choice.type === 'repeating_group') addRepeatingGroup(tile.choice, at);
  else if (tile.choice.type === 'section_break') {
    const doc = currentDoc();
    const n = Object.values(doc.blocks).filter((b) => b?.type === 'section_break').length + 1;
    const id = addBlock({ ...tile.choice, configOverrides: { ...tile.choice.configOverrides, name: `Section ${n}` } }, at);
    if (id && currentDoc().behavior.sectionNav?.mode === 'paged') {
      const place = placementOf(currentDoc(), id);
      if (place && place.index > 0 && 'pageId' in place.parent && !('blockId' in place.parent)) {
        insertPageBreak({ pageId: place.pageId, index: place.index });
      }
    }
  } else {
    addBlock(tile.choice, at, tilePatch(tile));
  }
}

/** What a block made from a palette tile starts with: a value field is named after its tile. */
function tilePatch(tile: Extract<Tile, { kind: 'block' }>): BlockPatch {
  const kind = REGISTRY[tile.choice.type].kind;
  if (kind === 'content' || kind === 'container' || kind === 'transient') return {};
  const fillBlank = tile.choice.type === 'short_text' && 'placeholder' in tile.choice.configOverrides && tile.choice.configOverrides.placeholder === '_____';
  return { label: inlineDoc(tile.label), ...(tile.required ? { required: true } : {}), ...(fillBlank ? { hideLabel: true } : {}) };
}

/**
 * Places a new block for a palette tile beside `hostId` as a half-width pair, made the same way as a click or a drop
 * between blocks (named after its tile). A page break cannot sit beside a block, so it is inserted at the end instead.
 */
export function placeTileBeside(hostId: BlockId, tile: Tile): void {
  if (tile.kind !== 'block') {
    insertTile(tile);
    return;
  }
  placeBeside(hostId, { choice: tile.choice, patch: tilePatch(tile) });
}
