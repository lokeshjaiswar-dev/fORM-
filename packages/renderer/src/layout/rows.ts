import type { BlockLayout } from '@form/schema';

/** Twelfths of the row each width takes (PROP-08/09). */
export const SPAN: Readonly<Record<BlockLayout['width'], number>> = { full: 12, half: 6, third: 4, two_thirds: 8 };

export interface Placed<B> {
  block: B;
  span: number;
}

/**
 * Auto-packs blocks into rows: a block joins the previous row when it fits beside what is there, unless it
 * starts a new row. Styles collapse rows to one column below 640px.
 */
export function packRows<B extends { layout?: BlockLayout | undefined }>(blocks: readonly B[]): Array<Array<Placed<B>>> {
  const rows: Array<Array<Placed<B>>> = [];
  let used = 12;
  for (const block of blocks) {
    const span = SPAN[block.layout?.width ?? 'full'] ?? 12;
    const row = rows[rows.length - 1];
    if (row && !block.layout?.startNewRow && used + span <= 12) {
      row.push({ block, span });
      used += span;
    } else {
      rows.push([{ block, span }]);
      used = span;
    }
  }
  return rows;
}
