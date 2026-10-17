import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BlockInspector } from '@/components/builder/BlockInspector';
import { useFormStore } from '@/store/useFormStore';
import { block, resetStore } from '@/test/fixtures';

const options = () => useFormStore.getState().form.blocks[0].options ?? [];

beforeEach(() => {
  resetStore([
    block('dropdown', {
      id: 'color',
      label: 'Color',
      options: [
        { id: 'o1', label: 'Option 1', value: 'option_1' },
        { id: 'o2', label: 'Option 2', value: 'option_2' },
        { id: 'o3', label: 'Option 3', value: 'option_3' },
      ],
    }),
  ]);
  useFormStore.getState().openInspector('color');
});

function renderInspector() {
  render(<BlockInspector />);
  return userEvent.setup();
}

function optionRow(label: string) {
  return screen.getByDisplayValue(label).closest('li')!;
}

describe('BlockInspector options', () => {
  it('adds an option numbered after the current count', async () => {
    const user = renderInspector();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(options().at(-1)).toMatchObject({ label: 'Option 4', value: 'option_4' });
  });

  it('removes an option', async () => {
    const user = renderInspector();
    await user.click(optionRow('Option 2').querySelectorAll('button')[2]);
    expect(options().map((o) => o.id)).toEqual(['o1', 'o3']);
  });

  it('renames an option label', async () => {
    const user = renderInspector();
    const input = screen.getByDisplayValue('Option 1');
    await user.clear(input);
    await user.type(input, 'Red');
    expect(options()[0].label).toBe('Red');
  });

  it.fails('B15: renaming an option keeps its stored value', async () => {
    const user = renderInspector();
    const input = screen.getByDisplayValue('Option 1');
    await user.clear(input);
    await user.type(input, 'Red');
    expect(options()[0].value).toBe('option_1');
  });

  it.fails('B16: option values stay unique after delete then add', async () => {
    const user = renderInspector();
    await user.click(optionRow('Option 2').querySelectorAll('button')[2]);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const values = options().map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });
});
