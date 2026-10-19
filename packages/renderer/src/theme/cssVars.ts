import type { CSSProperties } from 'react';
import { tokenVar, type ColorValue, type FontId, type ThemeColorToken, type ThemeTokens } from '@form/schema';

/*
 * DSN-01..06: theme tokens become CSS custom properties on `.fr-root`; styles.css reads only these, so a theme change
 * never touches a component. Brand refs are resolved at publish (I11); one that is still a ref falls back to the default.
 */

const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const DEFAULT_COLORS: Readonly<Record<ThemeColorToken, string>> = {
  page: '#ffffff',
  surface: '#ffffff',
  text: '#37352f',
  muted: '#6b6a66',
  accent: '#2383e2',
  accentText: '#ffffff',
  inputBg: '#ffffff',
  inputBorder: '#8c8b87',
  inputText: '#37352f',
  error: '#c4302b',
  success: '#2f7350',
};

const FONTS: Readonly<Record<string, string>> = {
  inter: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

const RADIUS: Readonly<Record<string, string>> = { none: '0px', sm: '4px', md: '6px', lg: '10px', full: '999px' };
const GAP: Readonly<Record<ThemeTokens['density'], string>> = { compact: '16px', comfortable: '24px', spacious: '32px' };
const WIDTH: Readonly<Record<ThemeTokens['formWidth'], string>> = { narrow: '560px', normal: '720px', wide: '920px' };

const fontStack = (font: FontId | object | undefined): string | undefined =>
  typeof font === 'string' ? (FONTS[font] ?? `"${font.replace(/["\\]/g, '')}", system-ui, sans-serif`) : undefined;

/** A colour value as CSS: hex as is, a token through its variable; brand refs and anything else give undefined. */
export function cssColor(value: ColorValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return HEX.test(value) ? value : undefined;
  if ('token' in value && Object.hasOwn(DEFAULT_COLORS, value.token)) return `var(${tokenVar(value.token)})`;
  return undefined;
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Black or white, whichever reads better on `background` (WCAG contrast); the default for `accentText`. */
export function readableOn(background: string): string {
  const l = luminance(background);
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#000000' : '#ffffff';
}

/** The custom properties for a theme, every token filled in. */
export function themeCssVars(tokens: ThemeTokens): CSSProperties {
  const vars: Record<string, string> = {};
  for (const token of Object.keys(DEFAULT_COLORS) as ThemeColorToken[]) {
    const value = tokens.colors[token];
    vars[tokenVar(token)] = typeof value === 'string' && HEX.test(value) ? value : DEFAULT_COLORS[token];
  }
  const accentText = tokens.colors.accentText;
  if (!(typeof accentText === 'string' && HEX.test(accentText))) vars[tokenVar('accentText')] = readableOn(vars[tokenVar('accent')] as string);
  vars['--fr-font'] = fontStack(tokens.typography.body) ?? (FONTS['inter'] as string);
  vars['--fr-heading-font'] = fontStack(tokens.typography.heading) ?? 'var(--fr-font)';
  vars['--fr-size'] = `${Math.min(24, Math.max(12, tokens.typography.baseSizePx || 16))}px`;
  vars['--fr-radius'] = typeof tokens.radius === 'string' ? (RADIUS[tokens.radius] ?? RADIUS['md'] as string) : (RADIUS['md'] as string);
  vars['--fr-gap'] = GAP[tokens.density] ?? GAP.comfortable;
  vars['--fr-width'] = WIDTH[tokens.formWidth] ?? WIDTH.normal;
  const background = tokens.background;
  if (background?.kind === 'color' && typeof background.color === 'string' && HEX.test(background.color)) vars['--fr-page'] = background.color;
  if (background?.kind === 'gradient' && typeof background.from === 'string' && typeof background.to === 'string' && HEX.test(background.from) && HEX.test(background.to)) {
    vars['--fr-page-image'] = `linear-gradient(${Math.round(background.angle) % 360}deg, ${background.from}, ${background.to})`;
  }
  return vars as CSSProperties;
}
