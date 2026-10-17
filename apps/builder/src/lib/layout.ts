import type { FormBlock } from '@/types/form';

export function isHalf(block: FormBlock) {
  return block.customize?.width === 'half';
}

export function packRows(blocks: FormBlock[]) {
  const rows: FormBlock[][] = [];
  for (const block of blocks) {
    const last = rows[rows.length - 1];
    const join =
      !!block.customize?.besidePrevious && isHalf(block) && last && last.length === 1 && isHalf(last[0]);
    if (join) last.push(block);
    else rows.push([block]);
  }
  return rows;
}
