import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DeleteBlockDialog } from '@/components/builder/DeleteBlockDialog';
import { requestDeleteBlock } from '@/state/actions';
import { useUiStore } from '@/state/uiStore';
import { block, blockIds, doc, resetStore } from '@/test/fixtures';

const rule = { enabled: true, action: 'show' as const, sourceBlockId: 'src', value: 'yes' };

beforeEach(() => {
  resetStore([block('text', { id: 'src', label: 'Do you drive?' }), block('text', { id: 'car', label: 'Car model', logic: rule })]);
});

describe('DeleteBlockDialog', () => {
  it('lists the rules that read the block and disables them on request (B21)', () => {
    requestDeleteBlock('src');
    render(<DeleteBlockDialog />);
    expect(screen.getByRole('heading', { name: 'Delete “Do you drive?”?' })).toBeInTheDocument();
    expect(screen.getByText('Show “Car model”')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disable rules' }));
    expect(blockIds()).toEqual(['car']);
    expect(doc().blocks[0].logic).toEqual({ ...rule, enabled: false });
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('removes the rules, or cancels and keeps everything', () => {
    requestDeleteBlock('src');
    render(<DeleteBlockDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(blockIds()).toEqual(['src', 'car']);
    expect(useUiStore.getState().pendingDelete).toBeNull();

    act(() => requestDeleteBlock('src'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove rules' }));
    expect(blockIds()).toEqual(['car']);
    expect(doc().blocks[0]).not.toHaveProperty('logic');
  });
});
