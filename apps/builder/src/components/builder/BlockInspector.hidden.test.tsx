import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BlockId, OptionId } from '@form/schema';
import { BlockInspector } from '@/components/builder/BlockInspector';
import { SHOWN_SETTINGS } from '@/components/builder/inspector/shownSettings';
import { useUiStore } from '@/state/uiStore';
import { block, resetStore } from '@/test/fixtures';

/* BlockInspector.test.tsx covers these settings with them shown; this checks the defaults the builder ships with. */
describe('Block settings hidden for now', () => {
  it('hides the pattern, uniqueness, API check, Advanced and Privacy on every field', () => {
    expect(Object.values(SHOWN_SETTINGS).every((shown) => shown === false)).toBe(true);
    resetStore([block('short_text', 'name')]);
    useUiStore.getState().openInspector('name' as BlockId);
    render(<BlockInspector />);

    expect(screen.getByRole('switch', { name: 'Primary key' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Pattern (regular expression)' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Must be unique on this form' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Validate with an API' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Advanced' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Privacy' })).not.toBeInTheDocument();
  });

  it('hides the number display choice, so numbers stay plain inputs', () => {
    resetStore([block('number', 'age')]);
    useUiStore.getState().openInspector('age' as BlockId);
    render(<BlockInspector />);

    expect(screen.getByRole('textbox', { name: 'Prefix' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Display' })).not.toBeInTheDocument();
  });

  it('hides Display and More options on a dropdown, but not on a radio list', () => {
    const options = [{ id: 'a' as OptionId, label: 'A' }];
    resetStore([block('single_choice', 'pick', { config: { display: 'dropdown', options } }), block('single_choice', 'radio', { config: { display: 'radio', options } })]);
    useUiStore.getState().openInspector('pick' as BlockId);
    const { unmount } = render(<BlockInspector />);

    expect(screen.getByRole('button', { name: /Add option/ })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Display' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /More options/i })).not.toBeInTheDocument();
    unmount();

    useUiStore.getState().openInspector('radio' as BlockId);
    render(<BlockInspector />);
    expect(screen.getByRole('combobox', { name: 'Display' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /More options/i })).toBeInTheDocument();
  });
});
