import type { CSSProperties } from 'react';
import type { FormTitleStyle, FormTitleWeight } from '@form/schema';

const WEIGHTS: Record<FormTitleWeight, number> = {
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
};

/** Classes and inline style for the form title (theme defaults + per-form overrides). */
export function formTitlePresentation(style: FormTitleStyle | undefined): {
  className: string;
  style: CSSProperties;
  headerStyle?: CSSProperties;
} {
  const present: CSSProperties = {};
  if (style?.textColor) present.color = style.textColor;
  if (style?.sizePx) present.fontSize = `${style.sizePx}px`;
  if (style?.weight) present.fontWeight = WEIGHTS[style.weight];
  const headerStyle: CSSProperties = {};
  if (style?.align) headerStyle.textAlign = style.align;
  return {
    className: 'fr-title',
    style: present,
    ...(Object.keys(headerStyle).length ? { headerStyle } : {}),
  };
}
