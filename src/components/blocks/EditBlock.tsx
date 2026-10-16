import { Star } from 'lucide-react';
import type { FieldType, FormBlock } from '@/types/form';
import { useFormStore } from '@/store/useFormStore';
import { cn } from '@/lib/utils';
import { inputStyle, labelStyle } from '@/lib/blockStyle';
import { SignaturePad } from '@/components/blocks/SignaturePad';
import { RichText } from '@/components/builder/RichText';

const box =
  'pointer-events-none flex min-h-10 w-full items-center rounded-md border border-zinc-200 bg-white px-3 text-[15px] text-zinc-400';

export function EditBlock({ block }: { block: FormBlock }) {
  const updateBlock = useFormStore((s) => s.updateBlock);
  const activeBlockId = useFormStore((s) => s.activeBlockId);
  const requestInsertFocus = useFormStore((s) => s.requestInsertFocus);
  const focused = activeBlockId === block.id;
  const placeholder = placeholderFor(block.type);
  const required = !!block.validation?.required;
  const width = 'w-full';

  function onEnter() {
    requestInsertFocus();
  }

  if (block.type === 'heading' || block.type === 'heading_2' || block.type === 'heading_3') {
    const size =
      block.type === 'heading' ? 'text-[32px]' : block.type === 'heading_2' ? 'text-[24px]' : 'text-[20px]';
    return (
      <RichText
        value={block.label}
        onChange={(label) => updateBlock(block.id, { label })}
        onEnter={onEnter}
        autoFocus={focused}
        className={cn('flex min-h-8 w-full items-center bg-transparent text-left font-bold leading-8 tracking-[-0.01em]', size)}
        style={labelStyle(block)}
        placeholder={placeholder}
      />
    );
  }

  if (block.type === 'paragraph') {
    return (
      <RichText
        value={block.label}
        onChange={(label) => updateBlock(block.id, { label })}
        onEnter={onEnter}
        autoFocus={focused}
        className="flex min-h-8 w-full items-center bg-transparent text-[16px] leading-8"
        style={labelStyle(block)}
        placeholder={placeholder}
      />
    );
  }

  if (block.type === 'divider') {
    return <hr className="my-4 border-zinc-200" />;
  }

  if (block.type === 'page_break') {
    return (
      <div className="flex items-center gap-3 py-2 text-[12px] uppercase tracking-wide text-zinc-400">
        <span className="h-px flex-1 bg-zinc-200" />
        Page break
        <span className="h-px flex-1 bg-zinc-200" />
      </div>
    );
  }

  if (block.type === 'thank_you') {
    return (
      <RichText
        value={block.label}
        onChange={(label) => updateBlock(block.id, { label })}
        onEnter={onEnter}
        autoFocus={focused}
        className="flex min-h-8 w-full items-center bg-transparent text-left text-[24px] font-semibold leading-8"
        placeholder="Thanks for your response"
      />
    );
  }

  return (
    <div className={cn('space-y-2', width)}>
      {!block.customize?.hideLabel && (
        <div className="flex h-8 min-w-0 items-center gap-1">
          <RichText
            value={block.label}
            onChange={(label) => updateBlock(block.id, { label })}
            onEnter={onEnter}
            autoFocus={focused}
            fill={false}
            className="min-h-8 min-w-[12.5rem] whitespace-nowrap bg-transparent text-left text-[22px] font-semibold leading-8"
            style={labelStyle(block)}
            placeholder={placeholder}
          />
          {required && <span className="shrink-0 text-[22px] font-semibold leading-8 text-black">*</span>}
        </div>
      )}
      {block.helpText ? <p className="text-left text-[13px] text-zinc-500">{block.helpText}</p> : null}
      <FieldPreview block={block} />
    </div>
  );
}

function placeholderFor(type: FieldType) {
  if (type === 'heading' || type === 'heading_2' || type === 'heading_3') return 'Heading';
  if (type === 'paragraph') return 'Type something…';
  if (type === 'hidden') return 'Hidden field name';
  return 'Type a question';
}

function FieldPreview({ block }: { block: FormBlock }) {
  const c = block.customize;
  const inner = (
    <>
      {c?.prefix ? <span className="mr-1 text-zinc-400">{c.prefix}</span> : null}
      <span className="truncate" style={{ color: c?.placeholderColor }}>
        {block.placeholder || 'Your answer'}
      </span>
      {c?.suffix ? <span className="ml-auto text-zinc-400">{c.suffix}</span> : null}
    </>
  );
  const boxStyle = inputStyle(block);
  const options = block.options ?? [];
  const max = c?.ratingMax ?? 5;
  const min = c?.scaleMin ?? 1;
  const scaleMax = c?.scaleMax ?? 5;

  switch (block.type) {
    case 'long_text':
      return (
        <div className={cn(box, 'h-24 items-start py-2')} style={boxStyle}>
          {inner}
        </div>
      );
    case 'dropdown':
    case 'multi_select':
      return (
        <div className={cn(box, 'justify-between')} style={boxStyle}>
          <span style={{ color: c?.placeholderColor }}>{block.placeholder ?? 'Select…'}</span>
          <span>▾</span>
        </div>
      );
    case 'multiple_choice':
    case 'checkbox':
    case 'ranking':
      return (
        <ul className="space-y-2 pt-1">
          {options.map((opt, i) => (
            <li key={opt.id} className="flex items-center gap-2 text-[15px]">
              <span
                className={cn(
                  'inline-flex size-4 items-center justify-center border border-zinc-300 bg-white text-[10px] text-zinc-400',
                  block.type === 'multiple_choice' ? 'rounded-full' : 'rounded-[3px]',
                )}
              >
                {block.type === 'ranking' ? i + 1 : null}
              </span>
              {opt.label}
            </li>
          ))}
          {c?.otherOption ? (
            <li className="flex items-center gap-2 text-[15px] text-zinc-400">
              <span className="inline-block size-4 rounded-full border border-zinc-300" /> Other…
            </li>
          ) : null}
        </ul>
      );
    case 'rating':
      return (
        <div className="flex gap-1 pt-1 text-zinc-300">
          {Array.from({ length: max }).map((_, i) => (
            <Star key={i} className="size-5" />
          ))}
        </div>
      );
    case 'linear_scale':
      return (
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[12px] text-zinc-400">{c?.scaleMinLabel}</span>
          {Array.from({ length: scaleMax - min + 1 }).map((_, i) => (
            <span key={i} className="flex size-8 items-center justify-center rounded-md border border-zinc-200 text-[13px] text-zinc-400">
              {min + i}
            </span>
          ))}
          <span className="text-[12px] text-zinc-400">{c?.scaleMaxLabel}</span>
        </div>
      );
    case 'nps':
      return (
        <div className="flex flex-wrap gap-1 pt-1">
          {Array.from({ length: 11 }).map((_, i) => (
            <span key={i} className="flex size-8 items-center justify-center rounded-md border border-zinc-200 text-[13px] text-zinc-400">
              {i}
            </span>
          ))}
        </div>
      );
    case 'file_upload':
      return (
        <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-zinc-300 text-[13px] text-zinc-400">
          Drop a file or click to upload
        </div>
      );
    case 'signature':
      return <SignaturePad disabled />;
    case 'hidden':
      return <p className="text-[12px] text-zinc-400">Hidden from respondents</p>;
    default:
      return (
        <div className={box} style={boxStyle}>
          {inner}
        </div>
      );
  }
}
