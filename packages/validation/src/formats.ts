import type { InputMask, TextPreset } from '@form/schema';
import { RE2JS } from 're2js';
import { compileBuiltIn, withinBudget } from './pattern.ts';

/*
 * Short-text presets (VAL-03) and input masks (PROP-12), both through re2js like author patterns.
 * Presets check the format only; checksums (GSTIN, PAN cross-check) arrive with WP-2.07.
 */

/** Separators (`\p{Z}`, NBSP included) and the C0/NEL whitespace controls: RE2's `\s` is ASCII-only. */
const SPACE = '\\p{Z}\\x{9}-\\x{D}\\x{85}';

export const PRESET_SOURCES: Readonly<Record<TextPreset, string>> = {
  alphabetic: '^[\\p{L}\\p{M}]+$',
  alphanumeric: '^[\\p{L}\\p{M}\\p{Nd}]+$',
  numeric: '^[0-9]+$',
  no_spaces: `^[^${SPACE}]+$`,
  in_pan: '^[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z]$',
  in_gstin: '^[0-9]{2}[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$',
  in_pincode: '^[1-9][0-9]{5}$',
  in_ifsc: '^[A-Z]{4}0[A-Z0-9]{6}$',
  in_vehicle_reg: '^(?:[A-Z]{2}[ -]?[0-9]{1,2}[ -]?(?:[A-Z]{1,3}[ -]?)?[0-9]{4}|[0-9]{2}[ -]?BH[ -]?[0-9]{4}[ -]?[A-Z]{1,2})$',
  in_aadhaar_last4: '^[0-9]{4}$',
};

/**
 * Presets are not held to `PATTERN_COST_BUDGET`: they are fixed here, anchored at both ends and under 50
 * instructions, and each is one repeated class or a short bounded sequence, so RE2 keeps one or two threads
 * alive and the cost is linear in the value with a small constant (200,000 code units take about 10 ms).
 * Validation only runs them on values within the field's length limit (at most 10,000 graphemes).
 */
export function matchesPreset(preset: TextPreset, value: string): boolean {
  const compiled = compileBuiltIn(PRESET_SOURCES[preset]);
  return compiled.ok && compiled.test(value);
}

const SLOT: Readonly<Record<string, string>> = { '#': '[0-9]', '@': '[\\p{L}\\p{M}]', '*': '[\\p{L}\\p{M}0-9]' };

/**
 * The anchored RE2 source a value must match for `mask`, or null when the mask is malformed. `#` is a digit,
 * `@` a letter, `*` either; any other character is a literal; one `[…]` at the end is an optional tail,
 * all or nothing. A value stored unmasked (`storeMasked: false`) holds the slot characters only.
 */
export function maskSource(mask: InputMask): string | null {
  const open = mask.pattern.indexOf('[');
  const close = mask.pattern.lastIndexOf(']');
  const hasTail = open >= 0 || close >= 0;
  if (hasTail && (open < 0 || close !== mask.pattern.length - 1 || open > close || mask.pattern.indexOf('[', open + 1) >= 0)) return null;
  if (hasTail && mask.pattern.indexOf(']') !== close) return null;
  const part = (text: string) => [...text].map((ch) => SLOT[ch] ?? (mask.storeMasked ? RE2JS.quote(ch) : '')).join('');
  const head = part(hasTail ? mask.pattern.slice(0, open) : mask.pattern);
  const tail = hasTail ? part(mask.pattern.slice(open + 1, close)) : '';
  return `^${head}${tail ? `(?:${tail})?` : ''}$`;
}

/** Whether `value` fits `mask`, or null when the mask is unusable. Masks are author input: a value over `PATTERN_COST_BUDGET` does not fit. */
export function matchesMask(mask: InputMask, value: string): boolean | null {
  const source = maskSource(mask);
  if (source === null) return null;
  const compiled = compileBuiltIn(source);
  return compiled.ok ? withinBudget(compiled, value) && compiled.test(value) : null;
}
