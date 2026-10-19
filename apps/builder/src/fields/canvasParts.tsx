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

const box = 'pointer-events-none flex min-h-10 w-full items-center rounded-md border border-zinc-200 bg-white px-3 text-[15px] text-zinc-400';

export function TextBox({ block, placeholder, prefix, suffix, tall }: { block: { style?: BlockStyle }; placeholder?: string | undefined; prefix?: string | undefined; suffix?: string | undefined; tall?: boolean }) {
  return (
    <div className={cn(box, tall && 'h-24 items-start py-2')} style={inputStyle(block.style)}>
      {prefix ? <span className="mr-1 text-zinc-400">{prefix}</span> : null}
      <span className="truncate" style={{ color: css(block.style?.placeholderColor) }}>
        {placeholder || t(M['canvas.answer'])}
      </span>
      {suffix ? <span className="ml-auto text-zinc-400">{suffix}</span> : null}
    </div>
  );
}

export function OptionList({ options, shape, numbered, other }: { options: readonly ChoiceOption[]; shape: 'round' | 'square'; numbered?: boolean; other?: boolean }) {
  return (
    <ul className="space-y-2 pt-1">
      {options.map((opt, i) => (
        <li key={opt.id} className="flex items-center gap-2 text-[15px]">
          <span className={cn('inline-flex size-4 items-center justify-center border border-zinc-300 bg-white text-[10px] text-zinc-400', shape === 'round' ? 'rounded-full' : 'rounded-[3px]')}>
            {numbered ? i + 1 : null}
          </span>
          {labelString(opt.label)}
        </li>
      ))}
      {other ? (
        <li className="flex items-center gap-2 text-[15px] text-zinc-400">
          <span className={cn('inline-block size-4 border border-zinc-300', shape === 'round' ? 'rounded-full' : 'rounded-[3px]')} /> {t(M['canvas.other'])}
        </li>
      ) : null}
    </ul>
  );
}

export function Select({ block, placeholder }: { block: { style?: BlockStyle }; placeholder?: string | undefined }) {
  return (
    <div className={cn(box, 'justify-between')} style={inputStyle(block.style)}>
      <span style={{ color: css(block.style?.placeholderColor) }}>{placeholder || t(M['canvas.select'])}</span>
      <span aria-hidden>▾</span>
    </div>
  );
}

export function Points({ from, to, low, high }: { from: number; to: number; low?: string | undefined; high?: string | undefined }): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-1 pt-1">
      {low ? <span className="mr-1 text-[12px] text-zinc-400">{low}</span> : null}
      {Array.from({ length: to - from + 1 }, (_, i) => (
        <span key={i} className="flex size-8 items-center justify-center rounded-md border border-zinc-200 text-[13px] text-zinc-400">
          {from + i}
        </span>
      ))}
      {high ? <span className="ml-1 text-[12px] text-zinc-400">{high}</span> : null}
    </div>
  );
}
