import type { CSSProperties } from 'react';
import type { Behavior } from '@form/schema';

type Submit = Behavior['submit'];

/** Classes and inline style for the primary submit control (theme + per-form overrides). */
export function submitButtonPresentation(submit: Submit, fullWidth?: boolean): { className: string; style: CSSProperties; 'data-submit-size'?: Submit['size']; 'data-submit-shape': Submit['shape'] | 'rounded' } {
  const style: CSSProperties = {};
  if (submit.bgColor) style.background = submit.bgColor;
  if (submit.textColor) style.color = submit.textColor;
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
