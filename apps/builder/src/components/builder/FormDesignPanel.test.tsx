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
    await user.click(screen.getByRole('button', { name: 'Form design' }));
    expect(screen.getByRole('dialog', { name: 'Form design' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Violet' }));
    expect(doc().theme.tokens.colors.accent).toBe('#7c3aed');
    expect(doc().theme.tokens.colors.page).toBe('#ede9fe');
  });

  it('applies a named theme and layout', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form design' }));
    await user.click(screen.getByRole('button', { name: 'Themes' }));
    await user.click(screen.getByRole('button', { name: /Midnight/ }));
    expect(doc().theme.tokens.colors.page).toBe('#0f172a');
    expect(doc().theme.tokens.inputStyle).toBe('filled');
    await user.click(screen.getByRole('button', { name: 'Layout' }));
    await user.click(screen.getByRole('button', { name: /Cards/ }));
    expect(doc().theme.layout).toBe('cards');
  });

  it('applies style tokens from the Styles tab without closing the panel', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form design' }));
    await user.click(screen.getByRole('button', { name: 'Styles' }));
    await user.click(screen.getByRole('button', { name: 'Form width' }));
    await user.click(screen.getByRole('button', { name: 'Wide' }));
    expect(doc().theme.tokens.formWidth).toBe('wide');
    await user.click(screen.getByRole('button', { name: 'Input style' }));
    await user.click(screen.getByRole('button', { name: 'Filled' }));
    expect(doc().theme.tokens.inputStyle).toBe('filled');
    await user.click(screen.getByRole('button', { name: 'Progress bar: Off' }));
    expect(doc().theme.tokens.progress).toBe('bar');
    expect(screen.getByRole('dialog', { name: 'Form design' })).toBeInTheDocument();
  });

  it('closes when clicking outside and keeps the password empty by default', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Outside</button>
        <FormDesignPanel />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'Form design' }));
    expect(screen.getByRole('dialog', { name: 'Form design' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(screen.getByLabelText('Password (optional)')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('dialog', { name: 'Form design' })).not.toBeInTheDocument();
  });
});
