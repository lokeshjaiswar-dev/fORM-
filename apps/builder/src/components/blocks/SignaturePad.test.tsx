import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { SignaturePad } from '@/components/blocks/SignaturePad';

const dataUrl = `data:image/png;base64,${'A'.repeat(64)}`;

beforeEach(() => {
  const ctx = { beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(dataUrl);
});

describe('SignaturePad', () => {
  it('reports the canvas image after a stroke', () => {
    const onChange = vi.fn();
    const { container } = render(<SignaturePad onChange={onChange} />);
    const canvas = container.querySelector('canvas')!;
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30 });
    fireEvent.pointerUp(window);
    expect(onChange).toHaveBeenLastCalledWith(dataUrl);
  });

  it.fails('B4: a pointerup without strokes does not produce a signature', () => {
    const onChange = vi.fn();
    render(<SignaturePad onChange={onChange} />);
    fireEvent.pointerUp(window);
    expect(onChange).not.toHaveBeenCalledWith(expect.stringMatching(/^data:/));
  });
});
