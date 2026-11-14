import { REGISTRY } from '@form/registry';
import type { Tile } from '@/fields/tiles';
import { inlineDoc, placementOf } from '@/lib/definition';
import { addBlock, addRepeatingGroup, insertPageBreak } from '@/state/actions';
import { currentDoc } from '@/state/documentStore';
import type { PageSlot } from '@/state/commands/types';

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
    const kind = REGISTRY[tile.choice.type].kind;
    const content = kind === 'content' || kind === 'container' || kind === 'transient';
    const overrides = tile.choice.configOverrides;
    const fillBlank = tile.choice.type === 'short_text' && 'placeholder' in overrides && overrides.placeholder === '_____';
    addBlock(tile.choice, at, content ? {} : { label: inlineDoc(tile.label), ...(tile.required ? { required: true } : {}), ...(fillBlank ? { hideLabel: true } : {}) });
  }
}
