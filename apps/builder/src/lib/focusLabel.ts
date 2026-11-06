import type { BlockId } from '@form/schema';

/** Place the caret after the last character of a block's canvas label. */
export function focusLabelEnd(id: BlockId): void {
  const place = () => {
    const root = document.querySelector(`[data-block-id="${id}"] .ProseMirror`);
    if (!(root instanceof HTMLElement) || !root.isConnected) return false;
    root.focus();
    const sel = window.getSelection();
    if (!sel) return true;
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  };
  if (place()) return;
  window.requestAnimationFrame(() => {
    if (place()) return;
    window.setTimeout(place, 0);
  });
}
