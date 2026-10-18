import type { BlockId, FormDefinition, PageId, StoredBlock } from '@form/schema';
import { cell } from './cells.ts';

/** Placement derived from a definition (parent links are derived by compile, never stored; schema §8). */
export interface Placement {
  /** DFS over pages → children → section and group children. */
  documentOrder: BlockId[];
  parentOf: Partial<Record<BlockId, BlockId | PageId>>;
  pageOf: Partial<Record<BlockId, PageId>>;
  pageIndex: ReadonlyMap<string, number>;
  /** Pages and blocks in render order: page, its blocks, next page, … (plan tie-break). */
  elementOrder: ReadonlyMap<string, number>;
}

const childrenOf = (block: StoredBlock): readonly BlockId[] =>
  block.type === 'section' || block.type === 'repeating_group' ? block.config.children : [];

/** Lenient: dangling, repeated and cyclic placements are skipped (validateStructure reports them). */
export function placementOf(def: FormDefinition): Placement {
  const documentOrder: BlockId[] = [];
  const parentOf: Partial<Record<BlockId, BlockId | PageId>> = {};
  const pageOf: Partial<Record<BlockId, PageId>> = {};
  const pageIndex = new Map<string, number>();
  const elementOrder = new Map<string, number>();
  def.pages.forEach((page, index) => {
    if (pageIndex.has(page.id)) return;
    pageIndex.set(page.id, index);
    elementOrder.set(page.id, elementOrder.size);
    const stack: Array<{ ids: readonly BlockId[]; parent: BlockId | PageId; next: number }> = [{ ids: page.children, parent: page.id, next: 0 }];
    for (let frame = stack.at(-1); frame; frame = stack.at(-1)) {
      const id = frame.ids[frame.next];
      frame.next += 1;
      if (id === undefined) {
        stack.pop();
        continue;
      }
      const block = def.blocks[id];
      if (!block || pageOf[id] !== undefined) continue;
      documentOrder.push(id);
      parentOf[id] = frame.parent;
      pageOf[id] = page.id;
      elementOrder.set(id, elementOrder.size);
      const children = childrenOf(block);
      if (children.length) stack.push({ ids: children, parent: id, next: 0 });
    }
  });
  return { documentOrder, parentOf, pageOf, pageIndex, elementOrder };
}

/** Ancestors of a block up to and including its page, nearest first. */
export function ancestorsOf(placement: Pick<Placement, 'parentOf'>, blockId: BlockId): Array<BlockId | PageId> {
  const out: Array<BlockId | PageId> = [];
  const seen = new Set<string>([blockId]);
  for (let parent = placement.parentOf[blockId]; parent !== undefined && !seen.has(parent); parent = placement.parentOf[parent as BlockId]) {
    out.push(parent);
    seen.add(parent);
  }
  return out;
}

/** `value(b)` also reads `visible` of b and every ancestor, and `onPath` of its page (schema §3.3.2). */
export function valueReadsOf(placement: Pick<Placement, 'parentOf' | 'pageOf'>, blockId: BlockId): string[] {
  const reads = [cell.value(blockId), cell.visible(blockId), ...ancestorsOf(placement, blockId).map((a) => cell.visible(a))];
  const page = placement.pageOf[blockId];
  if (page !== undefined) reads.push(cell.onPath(page));
  return reads;
}
