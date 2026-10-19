import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { BlockId } from '@form/schema';
import { DeleteBlockDialog } from '@/components/builder/DeleteBlockDialog';
import { requestDeleteBlock } from '@/state/actions';
import { useUiStore } from '@/state/uiStore';
import { block, blockIds, doc, resetStore, rule, text } from '@/test/fixtures';

const src = 'src' as BlockId;

beforeEach(() => {
  resetStore([block('short_text', 'src', { label: 'Do you drive?' }), block('short_text', 'car', { label: 'Car model' })], [rule('r1', 'src', 'eq', text('yes'), 'show', ['car'])]);
});

describe('DeleteBlockDialog', () => {
  it('lists the rules that read the block and disables them on request (B21)', () => {
    requestDeleteBlock(src);
    render(<DeleteBlockDialog />);
    expect(screen.getByRole('heading', { name: 'Delete “Do you drive?”?' })).toBeInTheDocument();
    expect(screen.getByText('Show “Car model”')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disable rules' }));
    expect(blockIds()).toEqual(['car']);
    expect(doc().logic.rules.map((r) => r.enabled)).toEqual([false]);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('removes the rules, or cancels and keeps everything', () => {
    requestDeleteBlock(src);
    render(<DeleteBlockDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(blockIds()).toEqual(['src', 'car']);
    expect(useUiStore.getState().pendingDelete).toBeNull();

    act(() => requestDeleteBlock(src));
    fireEvent.click(screen.getByRole('button', { name: 'Remove rules' }));
    expect(blockIds()).toEqual(['car']);
    expect(doc().logic.rules).toEqual([]);
    expect(doc().blocks['car' as BlockId]).not.toHaveProperty('initiallyHidden');
  });
});
