import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EmptyStart } from '@/components/builder/EmptyStart';
import { useUiStore } from '@/state/uiStore';
import { resetStore } from '@/test/fixtures';

beforeEach(() => {
  resetStore([]);
  useUiStore.setState({ started: false });
});

describe('EmptyStart', () => {
  it('tells the author how to begin, in words a screen reader reads as one sentence', () => {
    render(<EmptyStart />);
    expect(screen.getByRole('button')).toHaveAccessibleName('Drag & drop your first element from the left panel. Type / to insert a field.');
  });

  it('opens the insert line when the drop area is pressed', () => {
    const before = useUiStore.getState().insertFocusKey;
    render(<EmptyStart />);
    fireEvent.click(screen.getByRole('button', { name: /^Drag & drop your first element/ }));
    expect(useUiStore.getState()).toMatchObject({ started: true, insertFocusKey: before + 1 });
  });

  it('does not let the press reach the canvas, which would open the form settings', () => {
    let canvasClicks = 0;
    render(
      <div onClick={() => (canvasClicks += 1)}>
        <EmptyStart />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Drag & drop your first element/ }));
    expect(canvasClicks).toBe(0);
  });

  it('keeps the looping illustration out of the accessibility tree', () => {
    const { container } = render(<EmptyStart />);
    const loop = container.querySelector('.es-canvas')?.closest('[aria-hidden]');
    expect(loop).not.toBeNull();
    expect(container.querySelectorAll('.es-anim')).toHaveLength(15);
  });
});
