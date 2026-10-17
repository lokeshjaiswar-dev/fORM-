import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BuilderHeader } from '@/components/builder/BuilderHeader';
import { useFormStore } from '@/store/useFormStore';
import { resetStore } from '@/test/fixtures';

const blockCount = () => useFormStore.getState().form.blocks.length;

beforeEach(() => {
  resetStore();
  useFormStore.getState().addBlock('text');
  useFormStore.temporal.getState().undo();
});

describe('BuilderHeader shortcuts', () => {
  it('redoes with Mod+Shift+Z outside text fields', () => {
    render(<BuilderHeader />);
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(blockCount()).toBe(1);
  });

  it('B22: does not redo while typing in a field', () => {
    render(
      <>
        <BuilderHeader />
        <input aria-label="field" />
      </>,
    );
    const input = screen.getByLabelText('field');
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(input, { key: 'y', ctrlKey: true });
    expect(blockCount()).toBe(0);
  });
});
