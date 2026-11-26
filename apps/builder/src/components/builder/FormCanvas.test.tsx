import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_SECTION_NAV, type BlockId, type HexColor } from '@form/schema';
import { setBehavior, setTheme, updateBlock } from '@/state/actions';
import { applyImageTemplate, IMAGE_TEMPLATES, THEME_PRESETS } from '@/components/builder/design/presets';
import { useUiStore } from '@/state/uiStore';
import { inlineDoc } from '@/lib/definition';
import { useBlockClipboard } from '@/components/builder/useBlockClipboard';
import { block, blockIds, doc, keyOf, resetStore } from '@/test/fixtures';
import { SUBMIT_INSPECTOR_ID } from '@/components/builder/SubmitInspector';
import { TITLE_INSPECTOR_ID } from '@/components/builder/TitleInspector';
import { setTitleStyle } from '@/state/actions';
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
    expect(within(menu).getAllByRole('option').map((o) => o.textContent)).toEqual(['Dropdown', 'Searchable multi-select']);
    await user.click(within(menu).getByRole('option', { name: 'Dropdown' }));
    const added = blockIds()[2] as string;
    expect(doc().blocks[added as BlockId]).toMatchObject({ type: 'single_choice', config: { display: 'dropdown' } });
  });

  it("a block's + opens its menu as an overlay outside the canvas and inserts right after that block", async () => {
    const { container } = renderCanvas();
    const user = userEvent.setup();
    const insert = within(container.querySelector('[data-block-id="a"]') as HTMLElement).getByRole('button', { name: 'Insert block' });
    await user.click(insert);
    const menu = screen.getByRole('listbox').closest('[data-slash-menu]') as HTMLElement;
    expect(container).not.toContainElement(menu);
    expect(screen.getByPlaceholderText('Filter…')).toHaveFocus();
    await user.keyboard('date');
    await user.click(within(menu).getByRole('option', { name: 'Date' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(doc().blocks[blockIds()[1] as BlockId]).toMatchObject({ type: 'date' });
  });

  it('puts the caret at the end of the new field label', async () => {
    renderCanvas();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Type ‘/’ to insert blocks'), '/short');
    await user.click(screen.getByRole('option', { name: 'Short answer' }));
    await waitFor(() => {
      const sel = document.getSelection();
      expect(sel?.toString()).toBe('');
      expect(sel?.anchorNode?.textContent).toContain('Short answer');
    });
  });

  it('section breaks show a named navigator without looping updates', async () => {
    resetStore([
      block('section_break', 's1', { config: { name: 'Personal information', showInNav: true, showHeading: false } }),
      block('short_text', 'name', { label: 'Name' }),
      block('section_break', 's2', { config: { name: 'Education', showInNav: true, showHeading: false } }),
      block('short_text', 'school', { label: 'School' }),
    ]);
    act(() => setBehavior({ ...doc().behavior, sectionNav: { ...DEFAULT_SECTION_NAV, enabled: true } }));
    renderCanvas();
    const nav = screen.getByRole('navigation', { name: 'Form sections' });
    expect(nav).toHaveTextContent('Personal information');
    expect(nav).toHaveTextContent('Education');
    expect(nav.querySelector('[data-state="current"]')).toHaveTextContent('Personal information');
    const user = userEvent.setup();
    const personal = screen.getByDisplayValue('Personal information');
    await user.clear(personal);
    expect((doc().blocks['s1' as BlockId] as { config: { name: string } }).config.name).toBe('');
    expect(personal).toHaveValue('');
    await user.type(screen.getByPlaceholderText('Type ‘/’ to insert blocks'), '/section break');
    await user.click(screen.getByRole('option', { name: 'Section break' }));
    expect(screen.getByRole('navigation', { name: 'Form sections' })).toHaveTextContent('Section');
    expect(personal.closest('[data-marker]')).toHaveAttribute('data-marker', 'card');
    act(() => setBehavior({ ...doc().behavior, sectionNav: { ...DEFAULT_SECTION_NAV, ...doc().behavior.sectionNav, placement: 'left', chrome: 'circles' } }));
    expect(screen.getByRole('navigation', { name: 'Form sections' }).closest('[data-section-placement]')).toHaveAttribute('data-section-placement', 'left');
    expect(screen.getByRole('navigation', { name: 'Form sections' })).toHaveAttribute('data-chrome', 'circles');
    act(() => setBehavior({ ...doc().behavior, sectionNav: { ...DEFAULT_SECTION_NAV, ...doc().behavior.sectionNav, placement: 'bottom', chrome: 'bar' } }));
    expect(screen.getByRole('navigation', { name: 'Form sections' }).closest('[data-section-placement]')).toHaveAttribute('data-section-placement', 'bottom');
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this.id);
    };
    await user.click(screen.getByRole('button', { name: /Education/ }));
    expect(scrolled).toContain('section-s2');
    Element.prototype.scrollIntoView = original;
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

  it('focusing the form title selects it for block settings', async () => {
    renderCanvas();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Form title'));
    expect(useUiStore.getState().activeBlockId).toBe(TITLE_INSPECTOR_ID);
    expect(useUiStore.getState().inspectorOpen).toBe(true);
  });

  it('clicking the submit button selects it for block settings', async () => {
    renderCanvas();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open submit button settings' }));
    expect(useUiStore.getState().activeBlockId).toBe(SUBMIT_INSPECTOR_ID);
    expect(useUiStore.getState().inspectorOpen).toBe(true);
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
    const canvas = title.closest('[data-layout]');
    expect(canvas).toHaveStyle({ '--fr-accent': '#7c3aed', '--fr-page': '#fef3c7', '--fr-text': '#111827', color: 'var(--fr-text)', backgroundColor: 'var(--fr-page)' });
    act(() => setTitleStyle({ textColor: '#dc2626' as HexColor, sizePx: 36 }));
    expect(title).toHaveStyle({ color: 'rgb(220, 38, 38)', fontSize: '36px' });
    /* A theme accent colours Submit through --fr-submit-* (styles.css); no inline colour gets in its way. */
    expect(canvas).toHaveStyle({ '--fr-submit-bg': '#7c3aed', '--fr-submit-text': '#ffffff' });
    const submit = screen.getByRole('button', { name: 'Open submit button settings' });
    expect(submit.style.background).toBe('');
    expect(submit.style.color).toBe('');
  });

  it('keeps the slash menu unclipped and on builder chrome after a cover theme', async () => {
    renderCanvas();
    act(() => {
      setTheme(applyImageTemplate(doc().theme, IMAGE_TEMPLATES.find((t) => t.id === 'tpl-bloom') ?? IMAGE_TEMPLATES[0]!));
    });
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Type ‘/’ to insert blocks'), '/short');
    const menu = screen.getByRole('listbox').closest('[data-slash-menu]');
    expect(menu).toBeTruthy();
    expect(menu).toHaveStyle({ color: 'var(--popover-foreground)', fontSize: '14px' });
    const card = screen.getByLabelText('Form title').parentElement;
    expect(card).not.toHaveStyle({ overflow: 'hidden' });
    expect(within(screen.getByRole('listbox')).getByRole('option', { name: 'Short answer' })).toBeInTheDocument();
  });

  it('keeps slash-menu chrome readable on a dark form theme', async () => {
    renderCanvas();
    act(() => {
      const midnight = THEME_PRESETS.find((p) => p.id === 'midnight');
      if (midnight) setTheme({ ...doc().theme, layout: midnight.layout, tokens: midnight.tokens });
    });
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Type ‘/’ to insert blocks'), '/');
    expect(screen.getByRole('listbox').closest('[data-slash-menu]')).toHaveStyle({ color: 'var(--popover-foreground)' });
  });

  it('Enter on the last field moves the cursor to the insert row', async () => {
    resetStore([block('short_text', 'a', { label: 'Name' })]);
    renderCanvas();
    const user = userEvent.setup();
    const label = screen.getByRole('textbox', { name: 'Type a question' });
    label.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByPlaceholderText('Type ‘/’ to insert blocks')).toHaveFocus();
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
