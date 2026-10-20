import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BlockId } from '@form/schema';
import { setTheme, updateBlock } from '@/state/actions';
import { useUiStore } from '@/state/uiStore';
import { inlineDoc } from '@/lib/definition';
import { useBlockClipboard } from '@/components/builder/useBlockClipboard';
import { block, blockIds, doc, keyOf, resetStore } from '@/test/fixtures';
import { renderCanvas } from '@/test/canvas';
import { renders, resetRenders } from '@/test/profiler';

vi.mock('@/components/builder/CanvasBlock', async (original) => {
  const real = await original<typeof import('@/components/builder/CanvasBlock')>();
  const { profiledCanvasBlock } = await import('@/test/profiler');
  return { CanvasBlock: profiledCanvasBlock(real.CanvasBlock) };
});

beforeEach(() => resetStore([block('short_text', 'a', { label: 'First' }), block('email', 'b', { label: 'Second' })]));

describe('FormCanvas', () => {
  it('the slash menu lists the registry palette and inserts the chosen entry at the end', async () => {
    renderCanvas();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Type ‘/’ to insert blocks'), '/drop');
    const menu = screen.getByRole('listbox');
    expect(within(menu).getAllByRole('option').map((o) => o.textContent)).toEqual(['Dropdown', 'Multi-select dropdown']);
    await user.click(within(menu).getByRole('option', { name: 'Dropdown' }));
    const added = blockIds()[2] as string;
    expect(doc().blocks[added as BlockId]).toMatchObject({ type: 'single_choice', config: { display: 'dropdown' } });
  });

  it('a page break from the slash menu starts a new page, and removing it merges the pages', async () => {
    renderCanvas();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Type ‘/’ to insert blocks'), '/page');
    await user.click(screen.getByRole('option', { name: 'Page break' }));
    expect(doc().pages).toHaveLength(2);
    await user.type(screen.getByPlaceholderText('Type ‘/’ to insert blocks'), '/short');
    await user.click(screen.getByRole('option', { name: 'Short answer' }));
    expect(doc().pages.map((p) => p.children.length)).toEqual([2, 1]);
    expect(screen.getByRole('separator', { name: 'Page break' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove this page break' }));
    expect(doc().pages.map((p) => p.children.length)).toEqual([3]);
  });

  it('theme tokens colour the canvas and the submit button', () => {
    renderCanvas();
    act(() => {
      const theme = doc().theme;
      setTheme({
        ...theme,
        tokens: {
          ...theme.tokens,
          colors: { ...theme.tokens.colors, accent: '#7c3aed' as never, page: '#fef3c7' as never, text: '#111827' as never },
        },
      });
    });
    const title = screen.getByLabelText('Form title');
    const canvas = title.closest('.min-h-full');
    expect(canvas).toHaveStyle({ '--fr-accent': '#7c3aed', '--fr-page': '#fef3c7', '--fr-text': '#111827', color: 'var(--fr-text)', backgroundColor: 'var(--fr-page)' });
    expect(screen.getByRole('button', { name: /submit/i })).toHaveStyle({ background: 'var(--fr-accent)', color: 'var(--fr-accentText)' });
  });

  it('typing text on the insert line adds a paragraph', async () => {
    renderCanvas();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Type ‘/’ to insert blocks'), 'Some intro{Enter}');
    const added = doc().blocks[blockIds()[2] as BlockId];
    expect(added).toMatchObject({ type: 'paragraph', config: { content: { content: [{ content: [{ text: 'Some intro' }] }] } } });
  });

  it('FND-13: typing in one block re-renders that block only', () => {
    resetStore(Array.from({ length: 30 }, (_, i) => block('short_text', `q${i}`, { label: `Question ${i}` })));
    renderCanvas();
    resetRenders();
    act(() => {
      updateBlock('q7' as BlockId, { label: inlineDoc('Question seven') });
    });
    expect([...renders.keys()]).toEqual(['q7']);
    resetRenders();
    act(() => {
      updateBlock('q7' as BlockId, { label: inlineDoc('Question seven!') });
      updateBlock('q9' as BlockId, { required: true });
    });
    expect([...renders.keys()].sort()).toEqual(['q7', 'q9']);
  });

  it('BL-144: Mod+C and Mod+V copy and paste the selected block outside text fields', () => {
    function Shortcuts() {
      useBlockClipboard();
      return null;
    }
    renderCanvas();
    render(<Shortcuts />);
    act(() => useUiStore.getState().setActiveBlock('a' as BlockId));
    fireEvent.keyDown(document.body, { key: 'c', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'v', ctrlKey: true });
    expect(blockIds()).toHaveLength(3);
    const pasted = doc().blocks[blockIds()[1] as BlockId];
    expect(keyOf(pasted)).toBe('a_2');
    expect(useUiStore.getState().activeBlockId).toBe(blockIds()[1]);
    const input = screen.getByPlaceholderText('Type ‘/’ to insert blocks');
    fireEvent.keyDown(input, { key: 'v', ctrlKey: true });
    expect(blockIds()).toHaveLength(3);
  });

  it('BL-144: selected text and open dialogs keep Mod+C and Mod+V for text', () => {
    function Shortcuts() {
      useBlockClipboard();
      return null;
    }
    render(<Shortcuts />);
    const note = document.createElement('p');
    note.textContent = 'Some words to copy';
    document.body.append(note);
    act(() => useUiStore.setState({ activeBlockId: 'a' as BlockId, clipboard: null }));
    window.getSelection()?.selectAllChildren(note);
    const copy = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(false);
    expect(useUiStore.getState().clipboard).toBeNull();
    window.getSelection()?.removeAllRanges();
    fireEvent.keyDown(document.body, { key: 'c', ctrlKey: true });
    expect(useUiStore.getState().clipboard).not.toBeNull();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const button = document.createElement('button');
    dialog.append(button);
    document.body.append(dialog);
    fireEvent.keyDown(button, { key: 'v', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'v', ctrlKey: true });
    expect(blockIds()).toHaveLength(2);
    dialog.remove();
    note.remove();
  });
});
