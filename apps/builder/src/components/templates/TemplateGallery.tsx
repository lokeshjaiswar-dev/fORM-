import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { missingEditionFeatures } from '@form/config';
import { defineMessages } from '@form/i18n';
import type { FormDefinition, IsoInstant, TemplateVariable } from '@form/schema';
import { localizationOf, type Formpack, type FormpackTemplate } from '@form/templates';
import { useEdition } from '@/edition/edition';
import { t } from '@/i18n';
import { GALLERY_LOCALE, formFromTemplate, loadSystemPack, type VariableAnswers } from '@/lib/systemPack';
import { uid } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

const M = defineMessages('builder', {
  'gallery.loading': 'Loading templates…',
  'gallery.failed': 'The template pack could not be verified.',
  'gallery.retry': 'Try again',
  'gallery.back': 'Back to templates',
  'gallery.minutes': 'About {n, plural, one {# minute} other {# minutes}} to fill in',
  'gallery.fields': '{n, plural, one {# question} other {# questions}}',
  'gallery.use': 'Use template',
  'gallery.cancel': 'Cancel',
  'gallery.answers': 'Before you start',
  'gallery.required': '{label} (required)',
  'gallery.part': 'Includes: {label}',
  'gallery.hidden': '{n, plural, one {# template needs} other {# templates need}} features this installation does not offer.',
});

type Status = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; pack: Formpack };

export interface TemplateGalleryProps {
  /** Called with the instantiated v2 definition and the template's title. */
  onUse: (definition: FormDefinition, title: string) => void;
  onCancel: () => void;
  /** The confirming button's text (replacing a form says so). */
  useLabel?: string;
  /** A warning shown on the Use step, e.g. that the current form is replaced. */
  notice?: string;
}

const prompts = (template: FormpackTemplate): TemplateVariable[] => template.file.payload.variables.filter((v) => v.source === 'prompt');

function initialAnswers(variables: TemplateVariable[]): VariableAnswers {
  const out: VariableAnswers = {};
  for (const v of variables) if (v.default !== undefined) out[v.name] = v.default;
  return out;
}

/**
 * The New-form gallery over the bundled system pack (TPL-02): pick a template, answer its prompt variables and
 * optional parts in the Use step, and get a v2 definition from `instantiate()` (BL-117). One status state, so a
 * later successful load never shows an old error (BL-124).
 */
export default function TemplateGallery({ onUse, onCancel, useLabel, notice }: TemplateGalleryProps) {
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [picked, setPicked] = useState<FormpackTemplate | null>(null);
  const [answers, setAnswers] = useState<VariableAnswers>({});
  const edition = useEdition();

  useEffect(() => {
    let live = true;
    loadSystemPack().then(
      (pack) => live && setStatus({ state: 'ready', pack }),
      () => live && setStatus({ state: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  if (status.state === 'loading') return <p className="text-sm text-[var(--notion-text-muted)]">{t(M['gallery.loading'])}</p>;
  if (status.state === 'failed') {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-[var(--notion-text-muted)]">
          {t(M['gallery.failed'])}
        </p>
        <Button size="sm" variant="outline" onClick={() => {
            setStatus({ state: 'loading' });
            setAttempt((n) => n + 1);
          }}>
          {t(M['gallery.retry'])}
        </Button>
      </div>
    );
  }

  const { pack } = status;
  const pick = (template: FormpackTemplate) => {
    setAnswers(initialAnswers(prompts(template)));
    setPicked(template);
  };

  if (picked) {
    const text = localizationOf(picked.file, GALLERY_LOCALE);
    const title = text?.title ?? picked.entry.slug;
    const variables = prompts(picked);
    const payload = picked.file.payload;
    const parts = payload.kind === 'form' ? (payload.optionalParts ?? []) : [];
    const missing = variables.some((v) => v.required && (answers[v.name] === undefined || answers[v.name] === ''));
    const use = () => {
      const { definition } = formFromTemplate(pack, picked, { idSeed: uid(), bindingIdSeed: uid(), now: new Date().toISOString() as IsoInstant, variables: answers });
      onUse(definition, title);
    };
    return (
      <div className="space-y-4">
        <button type="button" className="inline-flex items-center gap-1 text-[13px] text-[var(--notion-text-muted)] hover:underline" onClick={() => setPicked(null)}>
          <ArrowLeft className="size-3.5" /> {t(M['gallery.back'])}
        </button>
        <div>
          <h3 className="text-[18px] font-semibold">{title}</h3>
          {text?.summary ? <p className="mt-1 text-sm text-[var(--notion-text-muted)]">{text.summary}</p> : null}
          {payload.kind === 'form' ? <p className="mt-1 text-[12px] text-[var(--notion-text-faint)]">{t(M['gallery.minutes'], { n: payload.estimatedMinutes })}</p> : null}
        </div>
        {variables.length ? (
          <fieldset className="space-y-3">
            <legend className="text-[12px] font-medium uppercase tracking-wide text-zinc-400">{t(M['gallery.answers'])}</legend>
            {variables.map((v) => (
              <VariableInput key={v.name} variable={v} value={answers[v.name]} parts={parts.filter((p) => p.when.variable === v.name).map((p) => p.label)} onChange={(value) => setAnswers((a) => ({ ...a, [v.name]: value }))} />
            ))}
          </fieldset>
        ) : null}
        {notice ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{notice}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t(M['gallery.cancel'])}
          </Button>
          <Button disabled={missing} onClick={use}>
            {useLabel ?? t(M['gallery.use'])}
          </Button>
        </div>
      </div>
    );
  }

  /* A template the edition cannot run is hidden, like its features in the palette (architecture §1.5). */
  const forms = pack.templates.filter((tpl) => tpl.file.payload.kind === 'form');
  const usable = forms.filter((tpl) => missingEditionFeatures(edition, tpl.entry.requiredFeatures).length === 0);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {usable.length < forms.length ? (
        <p className="text-[12px] text-[var(--notion-text-faint)] sm:col-span-2">{t(M['gallery.hidden'], { n: forms.length - usable.length })}</p>
      ) : null}
      {usable.map((tpl) => {
        const text = localizationOf(tpl.file, GALLERY_LOCALE);
        const payload = tpl.file.payload;
        const fields = payload.kind === 'form' ? Object.values(payload.document.blocks).filter((b) => b !== undefined && 'compliance' in b).length : 0;
        return (
          <button key={tpl.entry.slug} type="button" onClick={() => pick(tpl)} className="rounded-[6px] border border-[var(--notion-border)] p-4 text-left hover:bg-[var(--notion-hover)]">
            <div className="font-medium">{text?.title ?? tpl.entry.slug}</div>
            <p className="mt-1 text-sm text-[var(--notion-text-muted)]">{text?.summary}</p>
            {fields ? <p className="mt-2 text-[12px] text-[var(--notion-text-faint)]">{t(M['gallery.fields'], { n: fields })}</p> : null}
          </button>
        );
      })}
    </div>
  );
}

function VariableInput({ variable, value, parts, onChange }: { variable: TemplateVariable; value: string | number | boolean | undefined; parts: string[]; onChange: (value: string | number | boolean) => void }) {
  const label = variable.required ? t(M['gallery.required'], { label: variable.label }) : variable.label;
  const hint = [variable.help, ...parts.map((p) => t(M['gallery.part'], { label: p }))].filter(Boolean).join(' · ');
  if (variable.type === 'boolean') {
    return (
      <div className="space-y-0.5">
        <div className="flex items-center justify-between gap-3">
          <Label>{label}</Label>
          <Switch checked={value === true} onCheckedChange={onChange} aria-label={label} />
        </div>
        {hint ? <p className="text-[12px] text-[var(--notion-text-muted)]">{hint}</p> : null}
      </div>
    );
  }
  if (variable.type === 'select' && variable.options) {
    return (
      <label className="block space-y-1">
        <span className="text-sm font-medium text-zinc-800">{label}</span>
        <select className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="" />
          {variable.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {hint ? <span className="block text-[12px] text-[var(--notion-text-muted)]">{hint}</span> : null}
      </label>
    );
  }
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-zinc-800">{label}</span>
      <Input
        type={variable.type === 'number' ? 'number' : variable.type === 'date' ? 'date' : variable.type === 'email' ? 'email' : variable.type === 'url' ? 'url' : 'text'}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(variable.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
      />
      {hint ? <span className="block text-[12px] text-[var(--notion-text-muted)]">{hint}</span> : null}
    </label>
  );
}
