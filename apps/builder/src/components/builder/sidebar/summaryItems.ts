import type { BlockId, FormDefinition, PageId, StoredBlock } from '@form/schema';
import { tileOf, type Tile } from '@/fields/tiles';
import { blockText, childrenOf, isField } from '@/lib/definition';

/** One block of the form as the Summary tab lists it. */
export interface SummaryBlock {
  kind: 'block';
  id: BlockId;
  pageId: PageId;
  /** 0 for a block on the page, 1 and deeper for blocks inside a repeating group or section. */
  depth: number;
  label: string;
  typeLabel: string;
  tile: Tile | undefined;
  /** A question respondents answer, as opposed to a heading, text or divider. */
  field: boolean;
  required: boolean;
  readOnly: boolean;
  hidden: boolean;
}

/** Where a new page starts; only listed when the form has more than one page. */
export interface SummaryPage {
  kind: 'page';
  pageId: PageId;
  number: number;
}

export type SummaryItem = SummaryBlock | SummaryPage;

export interface SummaryCounts {
  blocks: number;
  required: number;
  hidden: number;
  readOnly: number;
}

function toItem(block: Exclude<StoredBlock, { type: 'unsupported' }>, id: BlockId, pageId: PageId, depth: number): SummaryBlock {
  const tile = tileOf(block.type, block.config as Readonly<Record<string, unknown>>);
  const typeLabel = tile?.label ?? block.type;
  const field = isField(block);
  return {
    kind: 'block',
    id,
    pageId,
    depth,
    label: blockText(block) || typeLabel,
    typeLabel,
    tile,
    field,
    required: field && block.required === true,
    readOnly: field && block.readOnly === true,
    hidden: field && (block.concealed === true || block.type === 'hidden'),
  };
}

/** Every block in form order (pages, then each block and the blocks inside it), with a marker where each page starts. */
export function summaryItems(def: FormDefinition): SummaryItem[] {
  const out: SummaryItem[] = [];
  const paged = def.pages.length > 1;
  const visit = (id: BlockId, pageId: PageId, depth: number) => {
    const block = def.blocks[id];
    if (!block || block.type === 'unsupported') return;
    out.push(toItem(block, id, pageId, depth));
    for (const child of childrenOf(block)) visit(child, pageId, depth + 1);
  };
  def.pages.forEach((page, i) => {
    if (paged) out.push({ kind: 'page', pageId: page.id, number: i + 1 });
    for (const id of page.children) visit(id, page.id, 0);
  });
  return out;
}

export function summaryCounts(items: readonly SummaryItem[]): SummaryCounts {
  const blocks = items.filter((i): i is SummaryBlock => i.kind === 'block');
  return {
    blocks: blocks.length,
    required: blocks.filter((b) => b.required).length,
    hidden: blocks.filter((b) => b.hidden).length,
    readOnly: blocks.filter((b) => b.readOnly).length,
  };
}

/** Blocks whose label or type matches the query; page markers are dropped while searching. */
export function filterSummary(items: readonly SummaryItem[], query: string): SummaryItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((i) => i.kind === 'block' && (i.label.toLowerCase().includes(q) || i.typeLabel.toLowerCase().includes(q)));
}
