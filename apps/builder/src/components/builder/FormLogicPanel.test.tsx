import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OptionId } from '@form/schema';
import { FormLogicPanel } from '@/components/builder/FormLogicPanel';
import { useUiStore } from '@/state/uiStore';
import { block, doc, resetStore } from '@/test/fixtures';

function open() {
  useUiStore.getState().setLogicOpen(true);
  render(<FormLogicPanel />);
  return userEvent.setup();
}

beforeEach(() => {
  resetStore([
    block('single_choice', 'state', {
      label: 'State',
      config: {
        display: 'dropdown',
        options: [
          { id: 'mh' as OptionId, label: 'Maharashtra', code: '27' },
          { id: 'ka' as OptionId, label: 'Karnataka', code: '29' },
        ],
      },
    }),
    block('short_text', 'gstin', { label: 'GSTIN' }),
  ]);
});

describe('FormLogicPanel', () => {
  it('adds a check that blocks submit on a field', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'Add a check' }));
    expect(doc().logic.rules).toHaveLength(1);
    expect(doc().logic.rules[0]?.then[0]).toMatchObject({ type: 'block_submit', anchorBlockId: 'gstin' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Error message' }), { target: { value: 'GSTIN does not match the selected state' } });
    expect(doc().logic.rules[0]?.then[0]).toMatchObject({ message: 'GSTIN does not match the selected state' });
  });

  it('adds a second condition on the same check', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'Add a check' }));
    await user.click(screen.getByRole('button', { name: 'Add condition' }));
    expect(doc().logic.rules[0]?.when.children).toHaveLength(2);
  });
});
