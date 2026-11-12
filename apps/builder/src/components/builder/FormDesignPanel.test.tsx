import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormDesignPanel } from '@/components/builder/FormDesignPanel';
import { doc, resetStore } from '@/test/fixtures';

beforeEach(() => resetStore());

describe('FormDesignPanel', () => {
  it('opens from the floating control and applies a color palette', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    expect(screen.getByRole('dialog', { name: 'Form settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Violet' }));
    expect(doc().theme.tokens.colors.accent).toBe('#7c3aed');
    expect(doc().theme.tokens.colors.page).toBe('#ede9fe');
    expect(screen.getByRole('dialog', { name: 'Form settings' })).toBeInTheDocument();
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
    expect(screen.getByRole('dialog', { name: 'Form settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Form width' }));
    await user.click(await screen.findByRole('option', { name: 'Wide' }));
    expect(doc().theme.tokens.formWidth).toBe('wide');
    await user.click(screen.getByRole('combobox', { name: 'Input style' }));
    await user.click(await screen.findByRole('option', { name: 'Filled' }));
    expect(doc().theme.tokens.inputStyle).toBe('filled');
    await user.click(screen.getByRole('button', { name: 'Progress bar: Off' }));
    expect(doc().theme.tokens.progress).toBe('bar');
    expect(screen.getByRole('dialog', { name: 'Form settings' })).toBeInTheDocument();
  });

  it('closes when clicking outside and keeps the password empty by default', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Outside</button>
        <FormDesignPanel />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    expect(screen.getByRole('dialog', { name: 'Form settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Logic' }));
    expect(screen.getByText(/When answers match/)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Submit' }));
    expect(screen.getByLabelText('Password (optional)')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('dialog', { name: 'Form settings' })).not.toBeInTheDocument();
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
