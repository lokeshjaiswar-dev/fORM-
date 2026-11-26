import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormDesignPanel } from '@/components/builder/FormDesignPanel';
import { doc, resetStore } from '@/test/fixtures';

/* These tests cover the Rules, Sections and API autofill tabs, so they turn them on; FormDesignPanel.hidden.test.tsx checks the shipped defaults. */
vi.mock('@/components/builder/design/shownTabs', () => ({ SHOWN_DESIGN_TABS: { logic: true, sections: true, lookup: true } }));

beforeEach(() => resetStore());

describe('FormDesignPanel', () => {
  it('opens from the floating control and applies a color palette', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    expect(screen.getByRole('region', { name: 'Form settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Colors' }));
    await user.click(screen.getByRole('button', { name: 'Violet' }));
    expect(doc().theme.tokens.colors.accent).toBe('#7c3aed');
    expect(doc().theme.tokens.colors.page).toBe('#ede9fe');
    expect(screen.getByRole('region', { name: 'Form settings' })).toBeInTheDocument();
  });

  it('shows Form settings when hovering the brush', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.hover(screen.getByRole('button', { name: 'Form settings' }));
    expect(await screen.findByRole('tooltip', { name: 'Form settings' })).toBeInTheDocument();
  });

  it('opens on Themes, the quickest way to a finished look, and orders the tabs by how often they are needed', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Themes', 'Colors', 'Layout', 'Submit', 'Rules', 'Sections', 'API autofill']);
    expect(screen.getByRole('tab', { name: 'Themes' })).toHaveAttribute('aria-selected', 'true');
    await user.type(screen.getByRole('searchbox', { name: 'Search themes' }), 'zzzz');
    expect(screen.getByText('No themes match “zzzz”.')).toBeInTheDocument();
  });

  it('applies a named theme', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    await user.click(screen.getByRole('tab', { name: 'Themes' }));
    await user.click(screen.getByRole('button', { name: /Midnight/ }));
    expect(doc().theme.tokens.colors.page).toBe('#0f172a');
    expect(doc().theme.tokens.inputStyle).toBe('filled');
  });

  it('applies layout tokens from the Layout tab with one click each, without closing the panel', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    await user.click(screen.getByRole('tab', { name: 'Layout' }));
    expect(screen.getByRole('region', { name: 'Form settings' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('radiogroup', { name: 'Form width' })).getByRole('radio', { name: 'Wide' }));
    expect(doc().theme.tokens.formWidth).toBe('wide');
    await user.click(within(screen.getByRole('radiogroup', { name: 'Input style' })).getByRole('radio', { name: 'Filled' }));
    expect(doc().theme.tokens.inputStyle).toBe('filled');
    const progress = screen.getByRole('switch', { name: 'Progress bar' });
    expect(progress).not.toBeChecked();
    await user.click(progress);
    expect(doc().theme.tokens.progress).toBe('bar');
    expect(progress).toBeChecked();
    expect(screen.getByRole('region', { name: 'Form settings' })).toBeInTheDocument();
  });

  it('stays open when clicking outside and closes with the X button', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Outside</button>
        <FormDesignPanel />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    expect(screen.getByRole('region', { name: 'Form settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Rules' }));
    expect(screen.getByText(/Each check has a name/)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Submit' }));
    expect(screen.getByLabelText('Password (optional)')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.getByRole('region', { name: 'Form settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Form settings' })).not.toBeInTheDocument());
  });

  it('enables section breaks from the tab after Logic and stores colour', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    await user.click(screen.getByRole('tab', { name: 'Sections' }));
    expect(screen.getByRole('switch', { name: 'Section break' })).not.toBeChecked();
    await user.click(screen.getByRole('switch', { name: 'Section break' }));
    expect(doc().behavior.sectionNav?.enabled).toBe(true);
    expect(doc().behavior.sectionNav?.mode).toBe('scroll');
    expect(screen.getByRole('radiogroup', { name: 'Behaviour' })).toBeInTheDocument();
    expect(screen.getByLabelText('Section colour')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Break the page' }));
    expect(doc().behavior.sectionNav?.mode).toBe('paged');
  });
});
