import { describe, expect, it } from 'vitest';
import type { HexColor } from '@form/schema';
import { submitButtonPresentation } from '../src/submitButton.ts';
import { id } from './build.ts';

describe('submitButtonPresentation', () => {
  it('maps colours, size, shape and full width', () => {
    const present = submitButtonPresentation({
      label: 'Go',
      align: 'full',
      bgColor: id<HexColor>('#111111'),
      textColor: id<HexColor>('#eeeeee'),
      size: 'lg',
      shape: 'pill',
    }, true);
    expect(present.className).toContain('w-full');
    expect(present.style).toEqual({ background: '#111111', color: '#eeeeee', borderRadius: 9999 });
    expect(present['data-submit-size']).toBe('lg');
    expect(present['data-submit-shape']).toBe('pill');
  });
});
