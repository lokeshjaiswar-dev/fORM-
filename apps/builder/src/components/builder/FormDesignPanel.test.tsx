import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormDesignPanel } from '@/components/builder/FormDesignPanel';
import { doc, resetStore } from '@/test/fixtures';

beforeEach(() => resetStore());

describe('FormDesignPanel', () => {
  it('opens from the floating control and applies a color palette', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    expect(screen.getByRole('region', { name: 'Form settings' })).toBeInTheDocument();
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

  it('applies a named theme', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    await user.click(screen.getByRole('tab', { name: 'Themes' }));
    await user.click(screen.getByRole('button', { name: /Midnight/ }));
    expect(doc().theme.tokens.colors.page).toBe('#0f172a');
    expect(doc().theme.tokens.inputStyle).toBe('filled');
  });

  it('applies style tokens from the Styles tab without closing the panel', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    await user.click(screen.getByRole('tab', { name: 'Styles' }));
    expect(screen.getByRole('region', { name: 'Form settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Form width' }));
    await user.click(await screen.findByRole('option', { name: 'Wide' }));
    expect(doc().theme.tokens.formWidth).toBe('wide');
    await user.click(screen.getByRole('combobox', { name: 'Input style' }));
    await user.click(await screen.findByRole('option', { name: 'Filled' }));
    expect(doc().theme.tokens.inputStyle).toBe('filled');
    await user.click(screen.getByRole('button', { name: 'Progress bar: Off' }));
    expect(doc().theme.tokens.progress).toBe('bar');
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
    expect(screen.getByRole('region', { name: 'Access' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password (optional)')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.getByRole('region', { name: 'Form settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Form settings' })).not.toBeInTheDocument());
  });

  it('has a Review tab before Submit where review units are made from the pages, even while nobody is signed in', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Colors', 'Styles', 'Themes', 'Logic', 'Sections', 'Review', 'Submit']);
    await user.click(screen.getByRole('tab', { name: 'Review' }));
    expect(screen.getByRole('region', { name: 'Review' })).toBeInTheDocument();
    // The assignments are the server's; without a session they are off and the reason is given, but the units are the draft's.
    expect(screen.getByText('Sign in to choose who reviews this form.')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Part of the form to check' }));
    await user.click(await screen.findByRole('option', { name: 'Page 1' }));
    await user.click(screen.getByRole('button', { name: 'Add review unit' }));
    expect(doc().review?.units).toEqual([{ id: expect.any(String), name: 'Page 1', target: { kind: 'page', pageId: 'page_1' } }]);
    expect(screen.getByLabelText('Name of the review unit for Page 1')).toHaveValue('Page 1');
    expect(screen.getByRole('combobox', { name: 'Group that checks Page 1' })).toBeDisabled();
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
    expect(screen.getByRole('combobox', { name: 'Behaviour' })).toBeInTheDocument();
    expect(screen.getByLabelText('Section colour')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Behaviour' }));
    await user.click(await screen.findByRole('option', { name: 'Break the page' }));
    expect(doc().behavior.sectionNav?.mode).toBe('paged');
  });
});
