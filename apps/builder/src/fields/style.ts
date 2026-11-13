import type { CSSProperties } from 'react';
import type { BlockStyle, ColorValue, LabelText } from '@form/schema';
import { colorCss } from '@/components/editor/extensions';

/** The literal text of a short label (option text, scale labels); piped values show their fallback. */
export function labelString(label: LabelText | undefined): string {
  if (label === undefined) return '';
  if (typeof label === 'string') return label;
  return label.map((part) => (typeof part === 'string' ? part : 'pipe' in part ? (part.pipe.fallback ?? '') : (part.var.fallback ?? ''))).join('');
}

export const css = (value: ColorValue | undefined): string | undefined => (value === undefined ? undefined : colorCss(value));

/** The block's own style for its input box (PROP-14). */
export function inputStyle(style: BlockStyle | undefined): CSSProperties {
  return {
    color: css(style?.inputTextColor),
    backgroundColor: css(style?.inputBg),
    borderColor: css(style?.borderColor),
    fontSize: style?.inputSizePx ? `${style.inputSizePx}px` : undefined,
    textAlign: style?.align,
  };
}

/** Block look colours as CSS variables the canvas field box reads (PROP-14). */
export function blockStyleVars(style: BlockStyle | undefined): CSSProperties | undefined {
  if (!style) return undefined;
  const vars: Record<string, string> = {};
  const set = (name: string, value: string | undefined) => {
    if (value !== undefined) vars[name] = value;
  };
  set('--fr-label-color', css(style.labelColor));
  set('--fr-input-color', css(style.inputTextColor));
  set('--fr-input-bg', css(style.inputBg));
  set('--fr-input-border', css(style.borderColor));
  set('--fr-placeholder', css(style.placeholderColor));
  return Object.keys(vars).length ? (vars as CSSProperties) : undefined;
}

/** The block's own style for its label (PROP-14). */
export function labelStyle(style: BlockStyle | undefined): CSSProperties {
  return {
    color: css(style?.labelColor),
    fontSize: style?.labelSizePx ? `${style.labelSizePx}px` : undefined,
    fontWeight: style?.labelWeight,
    textAlign: style?.align,
  };
}
