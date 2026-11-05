import type { ComponentType } from 'react';
import { Star } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { isAvailable, type AvailableType } from '@form/registry';
import type { BlockOf, NamePart } from '@form/schema';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { OptionList, Points, Select, TextBox } from '@/fields/canvasParts';
import { labelStyle } from '@/fields/style';
import { InlineEditor } from '@/components/editor/InlineEditor';
import { RichEditor } from '@/components/editor/RichEditor';
import { addChildBlock, updateBlock } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { isField, plainText } from '@/lib/definition';
import { Button } from '@dmacq/ui';

/*
 * The canvas view of every available block type (FND-03): what an author sees in place of the respondent control.
 * Value fields show a static preview of their control under the label editor; content blocks are edited in place.
 * The registry's AVAILABLE_TYPES is the key set, so a new available type does not compile without a view.
 */

export interface CanvasProps<T extends AvailableType> {
  block: BlockOf<T>;
  focused: boolean;
  onEnter: () => void;
}

export type CanvasView<T extends AvailableType> = ComponentType<CanvasProps<T>>;

const M = defineMessages('builder', {
  'canvas.upload': 'Drop a file or click to upload',
  'canvas.signature': 'Signature pad',
  'canvas.hidden': 'Hidden from respondents · filled from the URL parameter ‘{name}’',
  'canvas.hidden_utm': 'Hidden from respondents · filled from utm_{param}',
  'canvas.hidden_other': 'Hidden from respondents',
  'canvas.calculation': 'Result updates as answers change',
  'canvas.context': 'Filled from this session · {source}',
  'canvas.name.first': 'First name',
  'canvas.name.last': 'Last name',
  'canvas.name.middle': 'Middle name',
  'canvas.name.prefix': 'Prefix',
  'canvas.name.suffix': 'Suffix',
  'canvas.date': 'Pick a date',
  'canvas.time': 'Pick a time',
  'canvas.heading': 'Heading',
  'canvas.paragraph': 'Type something…',
  'canvas.repeat_add_field': 'Add a field to each row',
  'canvas.repeat_hint': '{min}–{max} rows · respondents can add more while filling',
  'canvas.repeat_child': 'Short answer',
});

const headingSize = { 1: 'text-[32px]', 2: 'text-[24px]', 3: 'text-[20px]' } as const;
const NAME_PART: Record<NamePart, typeof M['canvas.name.first']> = {
  prefix: M['canvas.name.prefix'],
  first: M['canvas.name.first'],
  middle: M['canvas.name.middle'],
  last: M['canvas.name.last'],
  suffix: M['canvas.name.suffix'],
};
const SPACING = { sm: 'my-2', md: 'my-4', lg: 'my-6' } as const;
const LINE = { solid: '', dashed: 'border-dashed', dotted: 'border-dotted', none: 'border-transparent' } as const;

export const CANVAS: { readonly [T in AvailableType]: CanvasView<T> } = {
  short_text: ({ block }) => <TextBox block={block} placeholder={block.config.placeholder} prefix={block.config.prefix} suffix={block.config.suffix} />,
  long_text: ({ block }) => <TextBox block={block} placeholder={block.config.placeholder} tall />,
  full_name: ({ block }) => (
    <div className="grid grid-cols-2 gap-3 pt-1">
      {block.config.parts.map((part) => (
        <div key={part} className="min-w-0">
          <p className="mb-1 text-[13px] text-[var(--fr-muted)]">{block.config.sublabels?.[part] || t(NAME_PART[part])}</p>
          <TextBox block={block} placeholder={block.config.placeholders?.[part]} />
        </div>
      ))}
    </div>
  ),
  email: ({ block }) => <TextBox block={block} placeholder={block.config.placeholder} prefix={block.config.prefix} suffix={block.config.suffix} />,
  phone: ({ block }) => <TextBox block={block} placeholder={block.config.placeholder} prefix={block.config.showCountrySelect ? `${block.config.defaultCountry} ▾` : undefined} />,
  number: ({ block }) => <TextBox block={block} placeholder={block.config.placeholder} prefix={block.config.prefix} suffix={block.config.suffix} />,
  url: ({ block }) => <TextBox block={block} placeholder={block.config.placeholder} prefix={block.config.prefix} suffix={block.config.suffix} />,
  single_choice: ({ block }) =>
    block.config.display === 'dropdown' ? <Select block={block} placeholder={block.config.placeholder} /> : <OptionList options={block.config.options} shape="round" other={block.config.other?.enabled === true} />,
  multi_choice: ({ block }) =>
    block.config.display === 'dropdown' ? <Select block={block} placeholder={block.config.placeholder} /> : <OptionList options={block.config.options} shape="square" other={block.config.other?.enabled === true} />,
  date: ({ block }) => <TextBox block={block} placeholder={`${t(M['canvas.date'])} · ${block.config.pattern}`} />,
  time: ({ block }) => <TextBox block={block} placeholder={`${t(M['canvas.time'])} · ${block.config.hourCycle === 'h12' ? '12h' : '24h'}`} />,
  rating: ({ block }) => (
    <div className="flex gap-1 pt-1 text-[var(--fr-muted)]">
      {Array.from({ length: Math.min(10, Math.max(1, block.config.max)) }, (_, i) => (
        <Star key={i} className="size-5" />
      ))}
    </div>
  ),
  linear_scale: ({ block }) => <Points from={block.config.min} to={block.config.max} low={block.config.lowLabel} high={block.config.highLabel} />,
  nps: ({ block }) => <Points from={0} to={10} low={block.config.lowLabel} high={block.config.highLabel} />,
  ranking: ({ block }) => <OptionList options={block.config.options} shape="square" numbered />,
  repeating_group: ({ block }) => <RepeatingGroupCanvas block={block} />,
  matrix: ({ block }) => (
    <div className="overflow-x-auto pt-1">
      <table className="w-full min-w-[280px] border-collapse text-[13px]">
        <thead>
          <tr>
            <th className="w-[28%] p-1 text-left font-medium text-[var(--fr-muted)]" />
            {block.config.columns.map((col) => (
              <th key={col.id} className="p-1 text-center font-medium text-[var(--fr-muted)]">{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.config.rows.map((row) => (
            <tr key={row.id}>
              <td className="p-1 text-[15px]">{typeof row.label === 'string' ? row.label : ''}</td>
              {block.config.columns.map((col) => (
                <td key={col.id} className="p-1 text-center">
                  <span className="inline-block size-4 rounded-full border" style={{ borderColor: 'var(--fr-inputBorder)', backgroundColor: 'var(--fr-inputBg)' }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
  file_upload: () => (
    <div className="flex h-20 items-center justify-center border border-dashed text-[13px] text-[var(--fr-muted)]" style={{ borderColor: 'var(--fr-inputBorder)', borderRadius: 'var(--fr-radius)' }}>{t(M['canvas.upload'])}</div>
  ),
  signature: ({ block }) => (
    <div className="flex items-center justify-center border text-[13px] text-[var(--fr-muted)]" style={{ height: Math.min(400, Math.max(80, block.config.heightPx)), backgroundColor: 'var(--fr-inputBg)', borderColor: 'var(--fr-inputBorder)', borderRadius: 'var(--fr-radius)' }}>
      {t(M['canvas.signature'])}
    </div>
  ),
  calculation: () => <p className="text-[12px] text-[var(--fr-muted)]">{t(M['canvas.calculation'])}</p>,
  context: ({ block }) => <p className="text-[12px] text-[var(--fr-muted)]">{t(M['canvas.context'], { source: block.config.source.replace(/_/g, ' ') })}</p>,
  hidden: ({ block }) => {
    const source = block.config.source;
    const text = source.kind === 'url_param' ? t(M['canvas.hidden'], { name: source.name ?? block.key }) : source.kind === 'utm' ? t(M['canvas.hidden_utm'], { param: source.param }) : t(M['canvas.hidden_other']);
    return <p className="text-[12px] text-[var(--fr-muted)]">{text}</p>;
  },
  heading: ({ block, focused, onEnter }) => (
    <InlineEditor
      value={block.config.text}
      onChange={(text) => updateBlock(block.id, { config: { ...block.config, text } })}
      onEnter={onEnter}
      autoFocus={focused}
      className={cn('flex min-h-8 w-full items-center bg-transparent text-left font-bold leading-8 tracking-[-0.01em]', headingSize[block.config.level])}
      style={labelStyle(block.style)}
      placeholder={t(M['canvas.heading'])}
    />
  ),
  paragraph: ({ block, focused, onEnter }) => (
    <RichEditor
      value={block.config.content}
      onChange={(content) => updateBlock(block.id, { config: { ...block.config, content } })}
      onEnter={onEnter}
      autoFocus={focused}
      className="flex min-h-8 w-full items-center bg-transparent text-[16px] leading-8"
      style={labelStyle(block.style)}
      placeholder={t(M['canvas.paragraph'])}
    />
  ),
  divider: ({ block }) => <hr className={cn(SPACING[block.config.spacing], LINE[block.config.lineStyle])} style={{ borderColor: 'var(--fr-inputBorder)' }} />,
};

function RepeatingGroupCanvas({ block }: { block: BlockOf<'repeating_group'> }) {
  const blocks = useDoc((d) => d.blocks);
  const children = block.config.children.map((id) => blocks[id]).filter((b) => b && b.type !== 'unsupported' && isAvailable(b.type));
  return (
    <div className="overflow-hidden rounded-md border" style={{ borderColor: 'var(--fr-inputBorder)' }} onClick={(e) => e.stopPropagation()}>
      <p className="border-b px-3 py-1.5 text-[12px] text-[var(--fr-muted)]" style={{ borderColor: 'var(--fr-inputBorder)' }}>
        {t(M['canvas.repeat_hint'], { min: block.config.minRows, max: block.config.maxRows })}
      </p>
      <div className="flex flex-wrap items-stretch">
        {children.map((child) => (
          <div key={child.id} className="min-w-[8rem] flex-1 border-r px-3 py-2 text-[13px] last:border-r-0" style={{ borderColor: 'var(--fr-inputBorder)' }}>
            <p>{isField(child) ? (plainText(child.label) || child.key) : child.type}</p>
            <p className="text-[11px] text-[var(--fr-muted)]">{child.type.replace(/_/g, ' ')}</p>
          </div>
        ))}
      </div>
      <div className="border-t px-2 py-1.5" style={{ borderColor: 'var(--fr-inputBorder)' }}>
        <Button type="button" variant="ghost" size="sm" onClick={() => addChildBlock(block.id, { type: 'short_text', configOverrides: {} })}>
          {t(M['canvas.repeat_add_field'])}
        </Button>
      </div>
    </div>
  );
}
