import { useState, type FormEvent, type ReactNode } from 'react';
import { useForm, type FieldValues, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Monitor, Star, Check, ChevronUp, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { useFormStore } from '@/store/useFormStore';
import { buildZodSchema, defaultValues } from '@/lib/zodFromBlocks';
import { isContentBlock, ratingCount, scaleRange } from '@/lib/fields';
import { isBlockVisible } from '@/lib/logic';
import { Textarea } from '@/components/ui/input';
import { NiceSelect } from '@/components/ui/select';
import { SignaturePad } from '@/components/blocks/SignaturePad';
import type { FormBlock, PreviewDevice } from '@/types/form';
import { cn } from '@/lib/utils';
import { inputStyle, labelStyle } from '@/lib/blockStyle';
import { isHalf, packRows } from '@/lib/layout';
import { Tooltip } from '@/components/ui/tooltip';
import { DeviceFrame } from '@/components/preview/DeviceFrame';
import { Confetti } from '@/components/preview/Confetti';
import { safeRedirectUrl, sanitizeHtml } from '@/lib/sanitize';

function pagesOf(blocks: FormBlock[]) {
  const pages: FormBlock[][] = [[]];
  for (const b of blocks) {
    if (b.type === 'page_break') pages.push([]);
    else pages[pages.length - 1].push(b);
  }
  return pages.filter((p) => p.length);
}

export function FormPreview() {
  const form = useFormStore((s) => s.form);
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const [submitted, setSubmitted] = useState(false);
  const [page, setPage] = useState(0);
  const [unlocked, setUnlocked] = useState(!form.settings.password);
  const [pw, setPw] = useState('');

  const resolver: Resolver<FieldValues> = (values, context, options) =>
    zodResolver(buildZodSchema(form.blocks.filter((b) => isBlockVisible(b, values, form.blocks))))(values, context, options);
  const rhf = useForm({
    resolver,
    defaultValues: defaultValues(form.blocks),
    mode: 'onBlur',
    reValidateMode: 'onBlur',
  });

  const pages = pagesOf(form.blocks);
  const current = pages[page] ?? [];
  const s = form.settings;
  const font = s.font === 'Georgia' ? 'Georgia, serif' : s.font === 'Mono' ? 'ui-monospace, monospace' : 'Inter, system-ui, sans-serif';
  const compact = device !== 'desktop';

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    if (page < pages.length - 1) {
      e.preventDefault();
      const values = rhf.getValues();
      const ids = current.filter((b) => isBlockVisible(b, values, form.blocks)).map((b) => b.id);
      if (!ids.length || (await rhf.trigger(ids, { shouldFocus: true }))) setPage((p) => p + 1);
      return;
    }
    await rhf.handleSubmit(() => {
      setSubmitted(true);
      toast.success(s.successMessage);
      const redirect = safeRedirectUrl(s.redirectUrl);
      if (redirect) window.location.assign(redirect);
    })(e);
  }

  let screen: ReactNode;
  if (s.closed) {
    screen = (
      <ScreenShell fill bg={s.backgroundColor} color={s.textColor} font={font}>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center">
          <h2 className="text-[22px] font-semibold">{s.closedMessage}</h2>
        </div>
      </ScreenShell>
    );
  } else if (!unlocked) {
    screen = (
      <ScreenShell fill bg={s.backgroundColor} color={s.textColor} font={font}>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center">
          <h2 className="text-[22px] font-semibold">This form is protected</h2>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            className="mt-4 h-10 w-full max-w-64 rounded-md border border-zinc-200 px-3"
            placeholder="Password"
          />
          <button
            type="button"
            className="mt-3 h-9 rounded-[4px] px-4 text-[14px] font-medium text-white"
            style={{ background: s.themeColor }}
            onClick={() => {
              if (pw === s.password) setUnlocked(true);
              else toast.error('Incorrect password');
            }}
          >
            Continue
          </button>
        </div>
      </ScreenShell>
    );
  } else if (submitted) {
    const ty = form.blocks.find((b) => b.type === 'thank_you');
    screen = (
      <ScreenShell fill bg={s.backgroundColor} color={s.textColor} font={font}>
        <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-8 text-center">
          {s.successAnimation ? <Confetti /> : null}
          <div className={cn('relative z-20 mx-auto flex size-12 items-center justify-center rounded-full bg-[#edf3ec] text-[#448361]', s.successAnimation && 'success-pop')}>
            <Check className="size-5" />
          </div>
          <h2 className="relative z-20 mt-4 max-w-md text-[22px] font-semibold">{ty?.label || s.successMessage}</h2>
          <button
            type="button"
            className="relative z-20 mt-6 rounded-[4px] px-3 py-1.5 text-[14px] text-zinc-500 hover:bg-zinc-100"
            onClick={() => {
              setSubmitted(false);
              setPage(0);
              rhf.reset(defaultValues(form.blocks));
            }}
          >
            Submit another response
          </button>
        </div>
      </ScreenShell>
    );
  } else {
    screen = (
      <ScreenShell bg={s.backgroundColor} color={s.textColor} font={font}>
        {s.progressBar && pages.length > 1 ? (
          <div className="h-1 w-full bg-zinc-100">
            <div className="h-full transition-all" style={{ width: `${((page + 1) / pages.length) * 100}%`, background: s.accentColor }} />
          </div>
        ) : null}
        {s.coverUrl ? <div className="h-28 w-full bg-cover bg-center" style={{ backgroundImage: `url(${s.coverUrl})` }} /> : null}
        <form
          onSubmit={(e) => void onSubmit(e)}
          className={cn('space-y-5', compact ? 'px-5 py-8' : 'px-10 py-10')}
        >
          {s.logoUrl ? <img src={s.logoUrl} alt="" className="h-10 object-contain" /> : null}
          {page === 0 && (
            <div>
              <h1 className={cn('text-left font-bold leading-[1.15] tracking-[-0.02em]', compact ? 'text-[28px]' : 'text-[40px]')}>
                {form.title || 'Form title'}
              </h1>
              {form.description ? <p className="mt-1 text-left text-[16px] opacity-70">{form.description}</p> : null}
            </div>
          )}
          {packRows(current.filter((b) => b.type !== 'thank_you')).map((row) => (
            <div key={row.map((b) => b.id).join('-')} className="flex w-full items-start gap-3">
              {row.map((block) => (
                <div key={block.id} className={cn(isHalf(block) ? 'w-1/2 min-w-0' : 'w-full')}>
                  <PreviewField block={block} rhf={rhf} values={rhf.watch()} blocks={form.blocks} accent={s.accentColor} />
                </div>
              ))}
            </div>
          ))}
          <div className="flex gap-2">
            {page > 0 ? (
              <button type="button" className="h-9 rounded-[4px] border border-zinc-200 px-4 text-[14px]" onClick={() => setPage((p) => p - 1)}>
                Back
              </button>
            ) : null}
            <button type="submit" className="h-9 rounded-[4px] px-4 text-[14px] font-medium text-white" style={{ background: s.themeColor }}>
              {page < pages.length - 1 ? 'Next' : s.submitButtonText}
            </button>
          </div>
        </form>
      </ScreenShell>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
      <div className="flex justify-center gap-0.5 py-1">
        {(
          [
            ['desktop', Monitor],
            ['tablet', TabletGlyph],
            ['mobile', PhoneGlyph],
          ] as const
        ).map(([id, Icon]) => (
          <Tooltip key={id} content={id === 'desktop' ? 'Desktop' : id === 'tablet' ? 'Tablet' : 'Mobile'}>
            <button
              type="button"
              onClick={() => setDevice(id)}
              className={cn(
                'flex size-8 items-center justify-center rounded-[4px]',
                device === id ? 'bg-zinc-100' : 'text-zinc-400 hover:bg-zinc-100',
              )}
            >
              <Icon className="size-4" />
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden px-4 py-4">
        <DeviceFrame device={device}>{screen}</DeviceFrame>
      </div>
    </div>
  );
}

function ScreenShell({
  children,
  bg,
  color,
  font,
  fill,
}: {
  children: ReactNode;
  bg: string;
  color: string;
  font: string;
  fill?: boolean;
}) {
  return (
    <div className={fill ? 'flex h-full min-h-full flex-col' : 'min-h-full'} style={{ background: bg, color, fontFamily: font }}>
      {children}
    </div>
  );
}

function PreviewField({
  block,
  rhf,
  values,
  blocks,
  accent,
}: {
  block: FormBlock;
  rhf: ReturnType<typeof useForm>;
  values: Record<string, unknown>;
  blocks: FormBlock[];
  accent: string;
}) {
  const err = (rhf.formState.errors[block.id]?.message as string | undefined) || undefined;
  if (!isBlockVisible(block, values, blocks)) return null;

  if (block.type === 'heading')
    return <h2 className="pt-2 text-left text-[30px] font-bold leading-[1.2]" dangerouslySetInnerHTML={{ __html: sanitizeHtml(block.label) }} />;
  if (block.type === 'heading_2')
    return <h3 className="pt-1 text-left text-[24px] font-bold" dangerouslySetInnerHTML={{ __html: sanitizeHtml(block.label) }} />;
  if (block.type === 'heading_3')
    return <h4 className="text-left text-[20px] font-semibold" dangerouslySetInnerHTML={{ __html: sanitizeHtml(block.label) }} />;
  if (block.type === 'paragraph')
    return <p className="text-left text-[16px] leading-[1.6]" dangerouslySetInnerHTML={{ __html: sanitizeHtml(block.label) }} />;
  if (block.type === 'divider') return <hr className="border-zinc-200" />;

  return (
    <div className="space-y-1.5 text-left">
      {!block.customize?.hideLabel && (
        <label className="text-[16px] font-medium" style={labelStyle(block)}>
          <span dangerouslySetInnerHTML={{ __html: sanitizeHtml(block.label) }} />
          {block.validation?.required && <span className="text-black"> *</span>}
        </label>
      )}
      {block.helpText ? <p className="text-[13px] opacity-60">{block.helpText}</p> : null}
      <Control block={block} rhf={rhf} accent={accent} />
      {err ? <p className="text-[12px] text-[#eb5757]">{err}</p> : null}
    </div>
  );
}

const fieldClass =
  'h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-[15px] outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10 disabled:bg-zinc-50';

function Control({ block, rhf, accent }: { block: FormBlock; rhf: ReturnType<typeof useForm>; accent: string }) {
  const style = inputStyle(block);
  const { register, watch, setValue } = rhf;
  const rating = Number(watch(block.id) || 0);
  const disabled = !!block.customize?.disabled;
  const autoFocus = !!block.customize?.autoFocus;
  const value = String(watch(block.id) ?? '');
  const extras = { disabled, autoFocus };
  const opts = [...(block.options ?? [])];
  if (block.customize?.otherOption) opts.push({ id: 'other', label: 'Other', value: 'other' });
  const max = ratingCount(block);
  const [min, scaleMax] = scaleRange(block);

  if (isContentBlock(block.type)) return null;

  switch (block.type) {
    case 'long_text':
      return (
        <div>
          <Textarea className={cn(fieldClass, 'min-h-20 py-2')} style={style} placeholder={block.placeholder} {...register(block.id)} {...extras} />
          {block.customize?.showCharCount && <p className="mt-1 text-right text-[11px] text-zinc-400">{value.length}</p>}
        </div>
      );
    case 'number':
      return wrapAffix(block, <input type="number" className={fieldClass} style={style} placeholder={block.placeholder} {...register(block.id)} {...extras} />);
    case 'email':
      return wrapAffix(block, <input type="email" className={fieldClass} style={style} placeholder={block.placeholder} {...register(block.id)} {...extras} />);
    case 'phone':
      return <input type="tel" className={fieldClass} style={style} placeholder={block.placeholder} {...register(block.id)} {...extras} />;
    case 'url':
      return <input type="url" className={fieldClass} style={style} placeholder={block.placeholder} {...register(block.id)} {...extras} />;
    case 'date':
      return <input type="date" className={fieldClass} style={style} {...register(block.id)} {...extras} />;
    case 'time':
      return <input type="time" className={fieldClass} style={style} {...register(block.id)} {...extras} />;
    case 'dropdown':
      return (
        <NiceSelect
          value={String(watch(block.id) ?? '')}
          disabled={disabled}
          placeholder={block.placeholder || 'Select…'}
          options={opts.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => setValue(block.id, v, { shouldValidate: true, shouldTouch: true })}
        />
      );
    case 'multiple_choice':
      return (
        <div className="space-y-2 pt-1">
          {opts.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-[15px]">
              <input type="radio" value={o.value} {...register(block.id)} />
              {o.label}
            </label>
          ))}
        </div>
      );
    case 'checkbox':
    case 'multi_select':
      return (
        <div className="space-y-2 pt-1">
          {opts.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-[15px]">
              <input type="checkbox" value={o.value} {...register(block.id)} />
              {o.label}
            </label>
          ))}
        </div>
      );
    case 'ranking': {
      const order = (watch(block.id) as string[]) ?? opts.map((o) => o.value);
      function move(i: number, dir: number) {
        const next = [...order];
        const j = i + dir;
        if (j < 0 || j >= next.length) return;
        [next[i], next[j]] = [next[j], next[i]];
        setValue(block.id, next, { shouldValidate: true });
      }
      return (
        <ul className="space-y-1 pt-1">
          {order.map((val, i) => {
            const o = opts.find((x) => x.value === val);
            return (
              <li key={val} className="flex items-center gap-2 rounded-md border border-zinc-200 px-2 py-1.5 text-[15px]">
                <span className="text-[12px] text-zinc-400">{i + 1}</span>
                <span className="flex-1">{o?.label ?? val}</span>
                <button type="button" onClick={() => move(i, -1)}>
                  <ChevronUp className="size-4" />
                </button>
                <button type="button" onClick={() => move(i, 1)}>
                  <ChevronDown className="size-4" />
                </button>
              </li>
            );
          })}
        </ul>
      );
    }
    case 'rating':
      return (
        <div className="flex gap-1 pt-1">
          {Array.from({ length: max }).map((_, i) => {
            const n = i + 1;
            return (
              <button key={n} type="button" onClick={() => setValue(block.id, n, { shouldValidate: true })}>
                <Star className={cn('size-6', n <= rating ? 'fill-[#f2c94c] text-[#f2c94c]' : 'text-[rgba(55,53,47,0.25)]')} />
              </button>
            );
          })}
        </div>
      );
    case 'linear_scale':
    case 'nps': {
      const from = block.type === 'nps' ? 0 : min;
      const to = block.type === 'nps' ? 10 : scaleMax;
      return (
        <div className="flex flex-wrap items-center gap-1 pt-1">
          {block.type === 'linear_scale' ? <span className="mr-1 text-[12px] opacity-60">{block.customize?.scaleMinLabel}</span> : null}
          {Array.from({ length: to - from + 1 }).map((_, i) => {
            const n = from + i;
            const on = rating === n;
            return (
              <button
                key={n}
                type="button"
                onClick={() => setValue(block.id, n, { shouldValidate: true })}
                className="flex size-8 items-center justify-center rounded-md border text-[13px]"
                style={on ? { background: accent, color: '#fff', borderColor: accent } : undefined}
              >
                {n}
              </button>
            );
          })}
          {block.type === 'linear_scale' ? <span className="ml-1 text-[12px] opacity-60">{block.customize?.scaleMaxLabel}</span> : null}
        </div>
      );
    }
    case 'file_upload':
      return <input type="file" multiple={!!block.customize?.allowMultiple} className="text-[14px]" {...register(block.id)} />;
    case 'signature':
      return <SignaturePad disabled={disabled} onChange={(data) => setValue(block.id, data, { shouldValidate: true })} />;
    default:
      return (
        <div>
          {wrapAffix(block, <input className={fieldClass} style={style} placeholder={block.placeholder} {...register(block.id)} {...extras} />)}
          {block.customize?.showCharCount && <p className="mt-1 text-right text-[11px] text-zinc-400">{value.length}</p>}
        </div>
      );
  }
}

function TabletGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="2" y="6" width="20" height="13" rx="2" stroke="currentColor" strokeWidth="1.75" />
      <circle cx="19.25" cy="12.5" r="0.85" fill="currentColor" />
    </svg>
  );
}

function PhoneGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="7" y="2" width="10" height="20" rx="2.2" stroke="currentColor" strokeWidth="1.75" />
      <rect x="9.5" y="4" width="5" height="1.4" rx="0.7" fill="currentColor" />
    </svg>
  );
}

function wrapAffix(block: FormBlock, control: ReactNode) {
  if (!block.customize?.prefix && !block.customize?.suffix) return control;
  return (
    <div className="flex items-center gap-2">
      {block.customize.prefix ? <span className="text-sm text-zinc-500">{block.customize.prefix}</span> : null}
      <div className="min-w-0 flex-1">{control}</div>
      {block.customize.suffix ? <span className="text-sm text-zinc-500">{block.customize.suffix}</span> : null}
    </div>
  );
}
