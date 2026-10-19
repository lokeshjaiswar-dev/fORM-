import { current, isDraft } from 'immer';
import type { FormBlock, FormSchema } from '@/types/form';
import type { BlockPatch, BlockSource, RuleFate } from '@/state/commands/types';

/* Block commands as immer recipes: each mutates a draft of the document and never touches the state it came from (B19). */

export interface IdSource {
  newId: () => string;
}

function reindex(blocks: FormBlock[]): void {
  blocks.forEach((block, i) => {
    if (block.order !== i) block.order = i;
  });
}

const indexOf = (doc: FormSchema, id: string) => doc.blocks.findIndex((b) => b.id === id);

/** Blocks whose rule reads `id`: in v1 a block's own `logic` is the rule that shows or hides it. */
export function rulesReading(blocks: readonly FormBlock[], id: string): FormBlock[] {
  return blocks.filter((b) => b.id !== id && b.logic?.sourceBlockId === id);
}

export function addBlock(doc: FormSchema, block: FormBlock, index: number): void {
  doc.blocks.splice(index, 0, block);
  reindex(doc.blocks);
}

export function updateBlock(doc: FormSchema, id: string, patch: BlockPatch): void {
  const block = doc.blocks[indexOf(doc, id)];
  for (const [key, value] of Object.entries(patch) as [keyof BlockPatch, unknown][]) {
    if (value === undefined) delete block[key];
    else (block as unknown as Record<string, unknown>)[key] = value;
  }
}

/** Full width also unpairs the block that sat beside this one, in the same history step. */
export function setWidth(doc: FormSchema, id: string, width: 'full' | 'half'): void {
  const i = indexOf(doc, id);
  const block = doc.blocks[i];
  block.customize = { ...block.customize, width, besidePrevious: false };
  const next = doc.blocks[i + 1];
  if (width === 'full' && next?.customize?.besidePrevious) next.customize.besidePrevious = false;
}

/** Deletes a block; rules that read it are removed or disabled, never left dangling (B21). */
export function deleteBlock(doc: FormSchema, id: string, rules: RuleFate): void {
  for (const reader of doc.blocks) {
    if (reader.id === id || reader.logic?.sourceBlockId !== id) continue;
    if (rules === 'remove') delete reader.logic;
    else reader.logic.enabled = false;
  }
  doc.blocks.splice(indexOf(doc, id), 1);
  reindex(doc.blocks);
}

/** Whether the block at `i` is half of a pair: it sits beside the previous block, or the next sits beside it. */
const paired = (doc: FormSchema, i: number) => Boolean(doc.blocks[i]?.customize?.besidePrevious || doc.blocks[i + 1]?.customize?.besidePrevious);

/**
 * A deep copy with fresh block and option ids (B20), right after the source, or after its pair when the source is
 * paired; a copy of a paired block is full width and pairs with nothing. The copy shares no objects with the source,
 * takes no rule (its own `logic`) and no template `origin`.
 */
export function duplicateBlock(doc: FormSchema, id: string, ids: IdSource): string {
  const i = indexOf(doc, id);
  const source = doc.blocks[i];
  const { logic: _logic, origin: _origin, ...rest } = structuredClone(isDraft(source) ? current(source) : source) as FormBlock & { origin?: unknown };
  const copy: FormBlock = { ...rest, id: ids.newId() };
  if (copy.options) copy.options = copy.options.map((o) => ({ ...o, id: ids.newId() }));
  let at = i + 1;
  if (paired(doc, i)) {
    copy.customize = { ...copy.customize, width: 'full', besidePrevious: false };
    if (doc.blocks[at]?.customize?.besidePrevious) at += 1;
  }
  doc.blocks.splice(at, 0, copy);
  reindex(doc.blocks);
  return copy.id;
}

/** Moves a block; it and the block that sat beside it are unpaired. */
export function moveBlock(doc: FormSchema, from: number, to: number): void {
  const follower = doc.blocks[from + 1];
  if (follower?.customize?.besidePrevious) follower.customize.besidePrevious = false;
  const [moved] = doc.blocks.splice(from, 1);
  moved.customize = { ...moved.customize, besidePrevious: false };
  doc.blocks.splice(to, 0, moved);
  reindex(doc.blocks);
}

/**
 * Puts a new or existing block beside `hostId`: both become half width, the placed one paired with the host. Blocks
 * that sat beside the host or beside the moved block are unpaired. A block is never placed beside itself (the
 * command's precondition).
 */
export function placeBeside(doc: FormSchema, hostId: string, source: BlockSource): string {
  const unpairFollower = (i: number) => {
    const follower = doc.blocks[i + 1];
    if (follower?.customize?.besidePrevious) follower.customize.besidePrevious = false;
  };
  const host = doc.blocks[indexOf(doc, hostId)];
  unpairFollower(indexOf(doc, hostId));
  host.customize = { ...host.customize, width: 'half', besidePrevious: false };
  let placed: FormBlock;
  if ('block' in source) {
    placed = source.block;
  } else {
    const from = indexOf(doc, source.id);
    unpairFollower(from);
    [placed] = doc.blocks.splice(from, 1);
  }
  placed.customize = { ...placed.customize, width: 'half', besidePrevious: true };
  doc.blocks.splice(indexOf(doc, hostId) + 1, 0, placed);
  reindex(doc.blocks);
  return placed.id;
}
