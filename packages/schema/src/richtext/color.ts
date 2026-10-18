import type { HexColor } from '../v2/ids.ts';
import type { ColorValue, ThemeColorToken } from '../v2/rich-text.ts';
import { ThemeColorTokenSchema } from '../v2/zod/rich-text.ts';

const NAMED: Readonly<Record<string, string>> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000',
  olive: '#808000', lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff', teal: '#008080', navy: '#000080',
  fuchsia: '#ff00ff', magenta: '#ff00ff', pink: '#ffc0cb', brown: '#a52a2a',
};

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

function channel(raw: string): number | null {
  const v = raw.trim();
  if (/^\d{1,3}(\.\d+)?%$/.test(v)) return (Number.parseFloat(v) / 100) * 255;
  if (/^\d{1,3}(\.\d+)?$/.test(v)) return Number.parseFloat(v);
  return null;
}

function alpha(raw: string | undefined): number | null {
  if (raw === undefined) return 1;
  const v = raw.trim();
  if (/^\d{1,3}(\.\d+)?%$/.test(v)) return Number.parseFloat(v) / 100;
  if (/^(\d+(\.\d+)?|\.\d+)$/.test(v)) return Math.min(1, Number.parseFloat(v));
  return null;
}

/**
 * A CSS colour from v1 HTML → `ColorValue`: hex, rgb()/rgba(), a small set of names, or `var(--fr-<token>)`.
 * Transparent and fully clear colours give `null`; anything else (url(), expression(), calc …) gives `undefined`.
 */
export function parseCssColor(input: string): ColorValue | null | undefined {
  const v = input.trim().toLowerCase().replace(/\s*!important$/, '');
  if (v === 'transparent') return null;
  const token = /^var\(\s*--fr-([a-z]+)\s*\)$/i.exec(input.trim());
  if (token) {
    const name = ThemeColorTokenSchema.options.find((t) => t.toLowerCase() === token[1]?.toLowerCase());
    return name ? { token: name } : undefined;
  }
  if (Object.hasOwn(NAMED, v)) return NAMED[v] as HexColor;
  let m = /^#([0-9a-f]{3,4})$/.exec(v);
  if (m?.[1]) {
    const [r = '', g = '', b = '', a] = m[1];
    if (a === '0') return null;
    return `#${r}${r}${g}${g}${b}${b}${a && a !== 'f' ? a + a : ''}` as HexColor;
  }
  m = /^#([0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (m?.[1]) {
    if (m[1].length === 8 && m[1].endsWith('00')) return null;
    return `#${m[1].length === 8 && m[1].endsWith('ff') ? m[1].slice(0, 6) : m[1]}` as HexColor;
  }
  m = /^rgba?\(([^()]*)\)$/.exec(v);
  if (m?.[1] !== undefined) {
    const parts = m[1].includes(',') ? m[1].split(',') : m[1].replace(/\s*\/\s*/, ' / ').split(/\s+/).filter((p) => p !== '/');
    if (parts.length !== 3 && parts.length !== 4) return undefined;
    const [r, g, b] = parts.slice(0, 3).map(channel);
    const a = alpha(parts[3]);
    if (r == null || g == null || b == null || a === null) return undefined;
    if (a === 0) return null;
    return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}` as HexColor;
  }
  return undefined;
}

/** CSS custom property a theme token renders through. */
export const tokenVar = (token: ThemeColorToken): string => `--fr-${token}`;
