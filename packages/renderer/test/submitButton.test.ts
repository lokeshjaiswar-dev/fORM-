import { describe, expect, it } from 'vitest';
import { submitButtonPresentation } from '../src/submitButton.ts';

describe('submitButtonPresentation', () => {
  it('maps colours, size, shape and full width', () => {
    const present = submitButtonPresentation({
      label: 'Go',
      align: 'full',
      bgColor: '#111111',
      textColor: '#eeeeee',
      size: 'lg',
      shape: 'pill',
    }, true);
    expect(present.className).toContain('w-full');
    expect(present.style).toEqual({ background: '#111111', color: '#eeeeee', borderRadius: 9999 });
    expect(present['data-submit-size']).toBe('lg');
    expect(present['data-submit-shape']).toBe('pill');
  });
});
