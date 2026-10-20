import type { ReactNode } from 'react';
import { defineMessages } from '@form/i18n';
import type { BlockStyle, ChoiceOption } from '@form/schema';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { css, inputStyle, labelString } from '@/fields/style';

/* Static previews of respondent controls, shared by the canvas views in fields/canvas.tsx. */

const M = defineMessages('builder', {
  'canvas.answer': 'Your answer',
  'canvas.select': 'Select…',
  'canvas.other': 'Other…',
});

const box = 'pointer-events-none flex min-h-10 w-full items-center border px-3 text-[15px]';
const controlStyle = {
  backgroundColor: 'var(--fr-inputBg)',
  borderColor: 'var(--fr-inputBorder)',
  color: 'var(--fr-muted)',
  borderRadius: 'var(--fr-radius)',
} as const;

export function TextBox({ block, placeholder, prefix, suffix, tall }: { block: { style?: BlockStyle }; placeholder?: string | undefined; prefix?: string | undefined; suffix?: string | undefined; tall?: boolean }) {
  return (
    <div className={cn(box, tall && 'h-24 items-start py-2')} style={{ ...controlStyle, ...inputStyle(block.style) }}>
      {prefix ? <span className="mr-1 text-[var(--fr-muted)]">{prefix}</span> : null}
      <span className="truncate" style={{ color: css(block.style?.placeholderColor) ?? 'var(--fr-muted)' }}>
        {placeholder || t(M['canvas.answer'])}
      </span>
      {suffix ? <span className="ml-auto text-[var(--fr-muted)]">{suffix}</span> : null}
    </div>
  );
}

export function OptionList({ options, shape, numbered, other }: { options: readonly ChoiceOption[]; shape: 'round' | 'square'; numbered?: boolean; other?: boolean }) {
  return (
    <ul className="space-y-2 pt-1">
      {options.map((opt, i) => (
        <li key={opt.id} className="flex items-center gap-2 text-[15px]">
          <span className={cn('inline-flex size-4 items-center justify-center border text-[10px] text-[var(--fr-muted)]', shape === 'round' ? 'rounded-full' : 'rounded-[3px]')} style={{ backgroundColor: 'var(--fr-inputBg)', borderColor: 'var(--fr-inputBorder)' }}>
            {numbered ? i + 1 : null}
          </span>
          {labelString(opt.label)}
        </li>
      ))}
      {other ? (
        <li className="flex items-center gap-2 text-[15px] text-[var(--fr-muted)]">
          <span className={cn('inline-block size-4 border', shape === 'round' ? 'rounded-full' : 'rounded-[3px]')} style={{ borderColor: 'var(--fr-inputBorder)' }} /> {t(M['canvas.other'])}
        </li>
      ) : null}
    </ul>
  );
}

export function Select({ block, placeholder }: { block: { style?: BlockStyle }; placeholder?: string | undefined }) {
  return (
    <div className={cn(box, 'justify-between')} style={{ ...controlStyle, ...inputStyle(block.style) }}>
      <span style={{ color: css(block.style?.placeholderColor) ?? 'var(--fr-muted)' }}>{placeholder || t(M['canvas.select'])}</span>
      <span aria-hidden>▾</span>
    </div>
  );
}

export function Points({ from, to, low, high }: { from: number; to: number; low?: string | undefined; high?: string | undefined }): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-1 pt-1">
      {low ? <span className="mr-1 text-[12px] text-[var(--fr-muted)]">{low}</span> : null}
      {Array.from({ length: to - from + 1 }, (_, i) => (
        <span key={i} className="flex size-8 items-center justify-center border text-[13px] text-[var(--fr-muted)]" style={controlStyle}>
          {from + i}
        </span>
      ))}
      {high ? <span className="ml-1 text-[12px] text-[var(--fr-muted)]">{high}</span> : null}
    </div>
  );
}
