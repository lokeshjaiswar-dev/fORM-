import { describe, expect, it } from 'vitest';
import type { HexColor, ThemeTokens } from '@form/schema';
import { submitButtonPresentation } from '../src/submitButton.ts';
import { darken, themeCssVars } from '../src/theme/cssVars.ts';
import { id } from './build.ts';

const tokensWith = (colors: Record<string, string>) =>
  ({ colors, typography: { body: 'inter', baseSizePx: 16 }, radius: 'md', density: 'comfortable', formWidth: 'normal' }) as unknown as ThemeTokens;
const vars = (colors: Record<string, string>) => themeCssVars(tokensWith(colors)) as Record<string, string | undefined>;

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

  it('gives a picked fill readable text when no text colour is picked', () => {
    expect(submitButtonPresentation({ label: 'Go', align: 'left', bgColor: id<HexColor>('#1e3a8a') }).style).toEqual({ background: '#1e3a8a', color: '#ffffff' });
    expect(submitButtonPresentation({ label: 'Go', align: 'left', bgColor: id<HexColor>('#facc15') }).style).toEqual({ background: '#facc15', color: '#000000' });
  });

  it('leaves the colours to the theme when the Submit settings pick none', () => {
    const present = submitButtonPresentation({ label: 'Go', align: 'left' });
    expect(present.style).toEqual({});
    expect(present['data-submit-shape']).toBe('rounded');
  });
});

describe('submit colours from the theme', () => {
  it('keeps the design-system blue while the accent is the default', () => {
    expect(vars({})['--fr-submit-bg']).toBeUndefined();
    expect(vars({ accent: '#2383E2' })['--fr-submit-bg']).toBeUndefined();
    expect(vars({ accent: '#2950da' })['--fr-submit-bg']).toBeUndefined();
  });

  it('follows a theme accent, darker on hover, with readable text', () => {
    const violet = vars({ accent: '#7c3aed' });
    expect(violet['--fr-submit-bg']).toBe('#7c3aed');
    expect(violet['--fr-submit-bg-hover']).toBe(darken('#7c3aed', 0.15));
    expect(violet['--fr-submit-text']).toBe('#ffffff');
    expect(vars({ accent: '#e2e8f0' })['--fr-submit-text']).toBe('#000000');
    expect(vars({ accent: '#7c3aed', accentText: '#fde68a' })['--fr-submit-text']).toBe('#fde68a');
    expect(vars({ accent: '#7c3aed80' })['--fr-submit-bg']).toBe('#7c3aed');
  });

  it('darkens toward black and drops alpha', () => {
    expect(darken('#ffffff', 0.5)).toBe('#808080');
    expect(darken('#2950da80', 0)).toBe('#2950da');
  });
});
