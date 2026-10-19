import { current, isDraft } from 'immer';
import type { Block, BlockId, BlockLayout, FormDefinition, OptionId, PageId, Purpose, StoredBlock } from '@form/schema';
import { childrenOf, freshKey, isField, placementOf, type IdSource } from '@/lib/definition';
import { dropTarget, pruneOptions, rulesReading, ruleReads, syncInitiallyHidden, ruleTargets } from '@/state/commands/rules';
import type { BlockPatch, BlockSource, PageSlot, RuleFate } from '@/state/commands/types';

/*
 * Block commands as immer recipes: each mutates a draft of the definition and never touches the state it came from
 * (B19). Layout follows the renderer's row packing (PROP-08/09): a half-width block joins the half block before it
 * unless it starts a new row. The builder pairs blocks only through "place beside", so every other half-width block
 * it writes starts its own row.
 */

type Draft = FormDefinition;

const plain = <T extends object>(value: T): T => (isDraft(value) ? (current(value as never) as T) : value);

/** The ordered child list that holds `id` (a page's or a container's), or null when the block is not placed. */
function siblingsOf(doc: Draft, id: BlockId): BlockId[] | null {
  const at = placementOf(doc, id);
  if (!at) return null;
  if ('pageId' in at.parent) return doc.pages.find((p) => p.id === (at.parent as { pageId: PageId }).pageId)?.children ?? null;
  const container = doc.blocks[at.parent.blockId];
  return container && (container.type === 'section' || container.type === 'repeating_group') ? container.config.children : null;
}

const pageChildren = (doc: Draft, pageId: PageId): BlockId[] | null => doc.pages.find((p) => p.id === pageId)?.children ?? null;

const layoutOf = (block: StoredBlock | undefined): BlockLayout | undefined => (block && block.type !== 'unsupported' ? block.layout : undefined);

const isHalf = (block: StoredBlock | undefined) => layoutOf(block)?.width === 'half';

/** Whether the block joins the row of the block before it (a half block that does not start a new row). */
const joinsPrevious = (block: StoredBlock | undefined) => isHalf(block) && !layoutOf(block)?.startNewRow;

function setLayout(block: StoredBlock | undefined, layout: BlockLayout | undefined): void {
  if (!block || block.type === 'unsupported') return;
  if (layout && layout.width !== 'full') block.layout = layout;
  else if (layout?.labelAlign) block.layout = { width: 'full', labelAlign: layout.labelAlign };
  else delete block.layout;
}

/** A half-width block that sat beside the block at `i` starts its own row instead. */
function unpairFollower(doc: Draft, siblings: readonly BlockId[], i: number): void {
  const id = siblings[i + 1];
  const follower = id === undefined ? undefined : doc.blocks[id];
  if (joinsPrevious(follower)) setLayout(follower, { ...(layoutOf(follower) as BlockLayout), startNewRow: true });
}

/** The block keeps its width but no longer joins the block before it. */
function ownRow(block: StoredBlock | undefined): void {
  if (isHalf(block)) setLayout(block, { ...(layoutOf(block) as BlockLayout), startNewRow: true });
}

/** Drops a block (and its descendants) from the definition; returns the ids removed. */
function remove(doc: Draft, id: BlockId): BlockId[] {
  const gone: BlockId[] = [];
  const visit = (b: BlockId) => {
    gone.push(b);
    childrenOf(doc.blocks[b]).forEach(visit);
  };
  visit(id);
  const siblings = siblingsOf(doc, id);
  if (siblings) {
    const i = siblings.indexOf(id);
    unpairFollower(doc, siblings, i);
    siblings.splice(i, 1);
  }
  for (const b of gone) delete doc.blocks[b];
  return gone;
}

/** Patches a block. A config edit that removes options also takes them out of the rules that named them. */
export function updateBlock(doc: Draft, id: BlockId, patch: BlockPatch): void {
  const block = doc.blocks[id] as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete block[key];
    else if (JSON.stringify(plain(block[key] as object)) !== JSON.stringify(value)) block[key] = value;
  }
  const options = (block['config'] as { options?: unknown } | undefined)?.options;
  if ('config' in patch && Array.isArray(options)) syncInitiallyHidden(doc, pruneOptions(doc, id, options as Array<{ id: OptionId }>));
}

/** Full width also unpairs the block that sat beside this one, in the same history step. */
export function setWidth(doc: Draft, id: BlockId, width: 'full' | 'half'): void {
  const block = doc.blocks[id];
  const siblings = siblingsOf(doc, id);
  if (siblings) unpairFollower(doc, siblings, siblings.indexOf(id));
  const labelAlign = layoutOf(block)?.labelAlign;
  setLayout(block, width === 'half' ? { width, startNewRow: true, ...(labelAlign ? { labelAlign } : {}) } : { width, ...(labelAlign ? { labelAlign } : {}) });
}

/**
 * Deletes a block; rules that read it are removed or disabled, never left dangling (B21), and it is dropped from the
 * targets of every rule. A half block that sat beside it starts its own row (BL-150).
 */
export function deleteBlock(doc: Draft, id: BlockId, fate: RuleFate): void {
  const gone = remove(doc, id);
  const touched = new Set<string>();
  for (const b of gone) {
    for (const rule of rulesReading(doc, b)) ruleTargets(rule).forEach((t) => touched.add(t));
    if (fate === 'remove') doc.logic.rules = doc.logic.rules.filter((r) => !ruleReads(r, b));
    else for (const rule of doc.logic.rules) if (ruleReads(rule, b)) rule.enabled = false;
    dropTarget(doc, b);
  }
  syncInitiallyHidden(doc, [...touched].filter((t) => !gone.includes(t as BlockId)));
}

/**
 * A copy of a block for a new place: a fresh id and key, no template `origin` (it is not the template's block) and no
 * `initiallyHidden` (rules are form-level and are never copied, so nothing would show it). Option ids are scoped to
 * their block and stay. Half-width copies start their own row.
 */
export function copyOf(block: Block, doc: Draft, ids: IdSource): Block {
  const { origin: _origin, initiallyHidden: _hidden, ...rest } = structuredClone(plain(block)) as Block & { origin?: unknown; initiallyHidden?: boolean };
  const copy = { ...rest, id: ids.newId() as BlockId } as Block;
  if (isField(copy)) copy.key = freshKey(doc, copy.key);
  ownRow(copy);
  return copy;
}

/** Duplicates a block right after it, or after its pair when it is paired. Returns the copy's id. */
export function duplicateBlock(doc: Draft, id: BlockId, ids: IdSource): BlockId {
  const source = doc.blocks[id] as Block;
  const copy = copyOf(source, doc, ids);
  const siblings = siblingsOf(doc, id) as BlockId[];
  let at = siblings.indexOf(id) + 1;
  const next = siblings[at];
  if (isHalf(source) && next !== undefined && joinsPrevious(doc.blocks[next])) at += 1;
  doc.blocks[copy.id] = copy;
  siblings.splice(at, 0, copy.id);
  return copy.id;
}

/**
 * Pastes a copied block at a page position (BL-144): a copy as `copyOf` makes it, never the copied block itself. The
 * copy may come from another form, so its purposes are this form's: those it names that exist here, else the first.
 * On a form without one, `purpose` is added first (I7), as a new block brings it.
 */
export function pasteBlock(doc: Draft, block: Block, at: PageSlot, ids: IdSource, purpose?: Purpose): BlockId {
  if (purpose) doc.privacy.purposes.push(purpose);
  const copy = copyOf(block, doc, ids);
  if (isField(copy)) {
    const known = copy.compliance.purposeIds.filter((id) => doc.privacy.purposes.some((p) => p.id === id));
    const first = doc.privacy.purposes[0]?.id;
    copy.compliance.purposeIds = known.length || copy.compliance.classification === 'none' || !first ? known : [first];
  }
  doc.blocks[copy.id] = copy;
  pageChildren(doc, at.pageId)?.splice(at.index, 0, copy.id);
  return copy.id;
}

/** Moves a block to a page position (the index counts the page's blocks without the moved one). It is unpaired. */
export function moveBlock(doc: Draft, id: BlockId, to: PageSlot): void {
  const siblings = siblingsOf(doc, id) as BlockId[];
  const from = siblings.indexOf(id);
  unpairFollower(doc, siblings, from);
  siblings.splice(from, 1);
  ownRow(doc.blocks[id]);
  pageChildren(doc, to.pageId)?.splice(to.index, 0, id);
}

/**
 * Puts a new or existing block beside `hostId`: both become half width, the placed one joining the host's row. Blocks
 * that sat beside the host or beside the moved block start their own rows. A block is never placed beside itself.
 */
export function placeBeside(doc: Draft, hostId: BlockId, source: BlockSource): BlockId {
  const host = doc.blocks[hostId];
  const hostSiblings = siblingsOf(doc, hostId) as BlockId[];
  unpairFollower(doc, hostSiblings, hostSiblings.indexOf(hostId));
  const labelAlign = layoutOf(host)?.labelAlign;
  setLayout(host, { width: 'half', startNewRow: true, ...(labelAlign ? { labelAlign } : {}) });
  let placed: StoredBlock;
  if ('block' in source) {
    if (source.purpose) doc.privacy.purposes.push(source.purpose);
    placed = source.block;
    doc.blocks[placed.id] = placed;
  } else {
    const siblings = siblingsOf(doc, source.id) as BlockId[];
    const from = siblings.indexOf(source.id);
    unpairFollower(doc, siblings, from);
    siblings.splice(from, 1);
    placed = doc.blocks[source.id] as StoredBlock;
  }
  const own = layoutOf(placed)?.labelAlign;
  setLayout(placed, { width: 'half', ...(own ? { labelAlign: own } : {}) });
  const siblings = siblingsOf(doc, hostId) as BlockId[];
  siblings.splice(siblings.indexOf(hostId) + 1, 0, placed.id);
  return placed.id;
}
