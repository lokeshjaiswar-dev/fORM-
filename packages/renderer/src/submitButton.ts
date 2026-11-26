import type { CSSProperties } from 'react';
import type { Behavior } from '@form/schema';
import { isHexColor, readableOn } from './theme/cssVars.ts';

type Submit = Behavior['submit'];

/** Classes and inline style for the primary submit control (theme + per-form overrides). */
export function submitButtonPresentation(submit: Submit, fullWidth?: boolean): { className: string; style: CSSProperties; 'data-submit-size'?: Submit['size']; 'data-submit-shape': Submit['shape'] | 'rounded' } {
  const style: CSSProperties = {};
  /* Colours picked in the Submit settings win; otherwise styles.css takes them from the theme (--fr-submit-*). */
  if (submit.bgColor) style.background = submit.bgColor;
  /* A picked fill without a picked text colour gets black or white, whichever reads on it, not the theme's. */
  if (submit.textColor) style.color = submit.textColor;
  else if (isHexColor(submit.bgColor)) style.color = readableOn(submit.bgColor);
  const shape = submit.shape ?? 'rounded';
  if (shape === 'square') style.borderRadius = 0;
  else if (shape === 'pill') style.borderRadius = 9999;
  const className = ['fr-button', 'fr-primary', fullWidth ? 'w-full' : ''].filter(Boolean).join(' ');
  return {
    className,
    style,
    ...(submit.size ? { 'data-submit-size': submit.size } : {}),
    'data-submit-shape': shape,
  };
}
