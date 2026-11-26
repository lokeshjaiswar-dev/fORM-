import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FieldPicker } from '@/components/builder/FieldPicker';
import { useUiStore } from '@/state/uiStore';
import { block, resetStore } from '@/test/fixtures';

beforeEach(() => {
  resetStore([block('short_text', 'name', { label: 'Full name' }), block('email', 'email', { label: 'Work email' })]);
  useUiStore.setState({ sidebarOpen: true, designOpen: false });
});

describe('FieldPicker', () => {
  it('names the panel and its tabs for what they do', () => {
    render(<FieldPicker />);
    expect(screen.getByRole('heading', { name: 'Toolbox' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Fields' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Structure' })).toBeInTheDocument();
  });

  it('opens search in place of the title row and closes it with the x inside the bar', () => {
    render(<FieldPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const search = screen.getByRole('searchbox', { name: 'Search' });
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute('placeholder', 'Search fields');
    expect(screen.queryByRole('heading', { name: 'Toolbox' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close sidebar' })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'zzz-no-match' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Toolbox' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('');
  });

  it('Escape leaves search, and the search filters the structure when that tab is open', () => {
    render(<FieldPicker />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Structure' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Structure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const search = screen.getByRole('searchbox', { name: 'Search' });
    expect(search).toHaveAttribute('placeholder', 'Search this form');
    fireEvent.change(search, { target: { value: 'email' } });
    expect(screen.getByRole('button', { name: 'Work email' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Full name' })).not.toBeInTheDocument();

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Full name' })).toBeInTheDocument();
  });
});
