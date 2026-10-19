// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SignaturePad } from '../src/index.ts';

const png = new Blob(['png'], { type: 'image/png' });

beforeEach(() => {
  const ctx = { beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), setTransform: vi.fn(), clearRect: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback, type?: string) {
    expect(type).toBe('image/png');
    callback(png);
  });
});

function sign(canvas: HTMLCanvasElement) {
  fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
  fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30 });
  fireEvent.pointerUp(window);
}

describe('SignaturePad', () => {
  it('reports the drawing as a PNG blob as the stroke ends (S10: never a data URL)', async () => {
    const onChange = vi.fn();
    const { container } = render(<SignaturePad onChange={onChange} />);
    sign(container.querySelector('canvas')!);
    expect(onChange).toHaveBeenCalledTimes(1);
    await expect(onChange.mock.lastCall?.[0]).resolves.toBe(png);
  });

  it('B4: a pointerup without strokes does not produce a signature', () => {
    const onChange = vi.fn();
    render(<SignaturePad onChange={onChange} />);
    fireEvent.pointerUp(window);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('B4: a tap without movement does not produce a signature', () => {
    const onChange = vi.fn();
    const { container } = render(<SignaturePad onChange={onChange} />);
    fireEvent.pointerDown(container.querySelector('canvas')!, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Clear empties the value', () => {
    const onChange = vi.fn();
    const { container } = render(<SignaturePad onChange={onChange} />);
    sign(container.querySelector('canvas')!);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('a disabled pad ignores strokes and has no Clear button', () => {
    const onChange = vi.fn();
    const { container } = render(<SignaturePad disabled onChange={onChange} />);
    sign(container.querySelector('canvas')!);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('B6: a new onChange each render does not re-bind listeners and the latest one is called', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const first = vi.fn();
    const latest = vi.fn();
    const { container, rerender } = render(<SignaturePad onChange={first} />);
    rerender(<SignaturePad onChange={vi.fn()} />);
    rerender(<SignaturePad onChange={latest} />);
    expect(add.mock.calls.filter(([type]) => type === 'pointerup')).toHaveLength(1);
    sign(container.querySelector('canvas')!);
    expect(first).not.toHaveBeenCalled();
    await expect(latest.mock.lastCall?.[0]).resolves.toBe(png);
  });

  it('B5: scales the backing store by devicePixelRatio', () => {
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 140, left: 0, top: 0 } as DOMRect);
    const { container } = render(<SignaturePad />);
    const canvas = container.querySelector('canvas')!;
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(280);
    expect(canvas.getContext('2d')!.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
  });
});
