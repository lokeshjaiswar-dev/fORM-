// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Confetti } from '../src/Confetti.tsx';

/* DSN-11: the success burst respects prefers-reduced-motion. */

function setup(reduced: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query === '(prefers-reduced-motion: reduce)', media: query }));
  const ctx = { save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), setTransform: vi.fn(), clearRect: vi.fn() };
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  const frame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
  return { getContext, frame };
}

describe('Confetti', () => {
  it('animates when motion is allowed', () => {
    const { getContext, frame } = setup(false);
    const { container } = render(<Confetti />);
    expect(container.querySelector('canvas')).toHaveAttribute('aria-hidden', 'true');
    expect(getContext).toHaveBeenCalled();
    expect(frame).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('draws and schedules nothing when the respondent prefers reduced motion', () => {
    const { getContext, frame } = setup(true);
    render(<Confetti />);
    expect(getContext).not.toHaveBeenCalled();
    expect(frame).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
