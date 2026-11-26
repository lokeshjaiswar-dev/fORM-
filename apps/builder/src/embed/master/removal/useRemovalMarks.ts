import { useCallback, useEffect, useRef } from 'react';
import type { Block, BlockId, PageId, StoredBlock } from '@form/schema';
import { placementOf } from '@/lib/definition';
import { dispatch } from '@/state/commands/dispatch';
import { currentDoc, useDocumentStore } from '@/state/documentStore';
import type { ServerFields } from '@/embed/master/DmsMasterRepository';

/*
 * "To be removed" (SEC-DESIGN 7.3, DESIGN 5.2). Deleting a block that DMS stores does not remove anything: the block leaves the canvas
 * and is marked here. The mark is derived, not stored: a stored field id with no block in the document is marked, so undo (which brings
 * the block back) clears it and redo sets it again. Nothing is sent until "Save to DMS", which asks for consent per marked field.
 *
 * The hook also keeps the last copy of each stored block while it is on the canvas, so "Restore" (and a cancelled consent dialog) puts the
 * block back as it was: same id, same place, same settings, as one undoable step.
 */

export interface RemovalMark {
  /** The DMS field id (= the block id). */
  id: string;
  /** The name DMS stores for the field. */
  name: string;
}

interface Shadow {
  block: StoredBlock;
  pageId: PageId;
  index: number;
}

export function useRemovalMarks(known: ServerFields | undefined): { marks: RemovalMark[]; restore: (id: string) => boolean } {
  const doc = useDocumentStore((s) => s.doc);
  const shadow = useRef(new Map<string, Shadow>());

  useEffect(() => {
    shadow.current = new Map();
    if (known === undefined) return;
    const remember = (def: ReturnType<typeof currentDoc>) => {
      for (const id of known.keys()) {
        const block = def.blocks[id as BlockId];
        if (!block) continue; // gone from the canvas: the last copy stays
        const at = placementOf(def, id as BlockId);
        const first = def.pages[0];
        const pageId = at?.pageId ?? first?.id;
        if (pageId === undefined) continue;
        shadow.current.set(id, { block, pageId, index: at?.index ?? first?.children.length ?? 0 });
      }
    };
    remember(currentDoc());
    return useDocumentStore.subscribe((state) => remember(state.doc));
  }, [known]);

  const marks: RemovalMark[] = known === undefined ? [] : [...known].filter(([id]) => doc.blocks[id as BlockId] === undefined).map(([id, name]) => ({ id, name }));

  const restore = useCallback((id: string): boolean => {
    const kept = shadow.current.get(id);
    const def = currentDoc();
    if (!kept || def.blocks[id as BlockId] !== undefined) return kept !== undefined;
    const page = def.pages.find((p) => p.id === kept.pageId) ?? def.pages[0];
    if (!page) return false;
    const result = dispatch({ type: 'apply_ops', ops: [{ op: 'add_block', block: kept.block as Block, parent: { pageId: page.id }, index: Math.min(kept.index, page.children.length) }] });
    return result.ok;
  }, []);

  return { marks, restore };
}
