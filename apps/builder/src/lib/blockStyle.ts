import type { CSSProperties } from 'react';
import type { FormBlock, FormSettings } from '@/types/form';

/** Theme tokens that rich-text colours render through (`var(--fr-accent)` …). */
export function themeVars(s: FormSettings): CSSProperties {
  return {
    '--fr-page': s.backgroundColor,
    '--fr-surface': '#ffffff',
    '--fr-text': s.textColor,
    '--fr-muted': '#787774',
    '--fr-accent': s.accentColor,
    '--fr-accentText': '#ffffff',
    '--fr-inputBg': '#ffffff',
    '--fr-inputBorder': '#e4e4e7',
    '--fr-inputText': s.textColor,
    '--fr-error': '#eb5757',
    '--fr-success': '#448361',
  } as CSSProperties;
}


export function labelStyle(block: FormBlock): CSSProperties {
  const c = block.customize;
  return {
    color: c?.labelColor || undefined,
    fontSize: c?.labelSize ? `${c.labelSize}px` : undefined,
    fontWeight: c?.labelWeight,
    textAlign: c?.align,
  };
}

export function inputStyle(block: FormBlock): CSSProperties {
  const c = block.customize;
  return {
    color: c?.inputTextColor || undefined,
    backgroundColor: c?.inputBg || undefined,
    borderColor: c?.borderColor || undefined,
    fontSize: c?.inputSize ? `${c.inputSize}px` : undefined,
    textAlign: c?.align,
  };
}
