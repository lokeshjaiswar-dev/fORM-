import { useEffect } from 'react';
import { copyBlock, pasteBlock } from '@/state/actions';
import { useUiStore } from '@/state/uiStore';

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);

/** Focus in a dialog, or an open modal dialog behind which the canvas sits. */
const inDialog = (target: EventTarget | null) =>
  (target instanceof Element && target.closest('[role="dialog"],[role="alertdialog"],dialog') !== null) || document.querySelector('[role="dialog"][aria-modal="true"],[role="alertdialog"],dialog[open]') !== null;

const hasTextSelection = () => {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString().length > 0;
};

/**
 * Block copy and paste (BL-144): with a block selected and focus outside any text field or editor, Mod+C copies it
 * and Mod+V pastes a fresh copy after the selected block (new id and key, no template origin, no rules). Inside a
 * text field, with text selected, or while a dialog is open the keys keep their text meaning.
 */
export function useBlockClipboard(): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || isTyping(e.target) || inDialog(e.target)) return;
      const key = e.key.toLowerCase();
      const { activeBlockId, clipboard } = useUiStore.getState();
      if (key === 'c' && activeBlockId && !hasTextSelection()) {
        if (copyBlock(activeBlockId)) e.preventDefault();
      } else if (key === 'v' && clipboard) {
        e.preventDefault();
        pasteBlock();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
