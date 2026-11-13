import { describe, expect, it } from 'vitest';
import { formTitlePresentation } from '../src/formTitle.ts';

describe('formTitlePresentation', () => {
  it('maps custom colour, size, weight and header alignment', () => {
    const present = formTitlePresentation({ textColor: '#112233', sizePx: 48, weight: 'bold', align: 'center' });
    expect(present.className).toBe('fr-title');
    expect(present.style).toEqual({ color: '#112233', fontSize: '48px', fontWeight: 700 });
    expect(present.headerStyle).toEqual({ textAlign: 'center' });
  });

  it('omits header style when alignment is unset', () => {
    expect(formTitlePresentation(undefined).headerStyle).toBeUndefined();
    expect(formTitlePresentation({ textColor: '#000000' }).headerStyle).toBeUndefined();
  });
});
