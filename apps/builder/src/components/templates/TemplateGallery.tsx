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
import { Button, Field, Input, Label, Switch, TextLink } from '@dmacq/ui';
import { NiceSelect } from '@/components/NiceSelect';

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

  if (status.state === 'loading') return <p className="text-sm text-muted-foreground">{t(M['gallery.loading'])}</p>;
  if (status.state === 'failed') {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-muted-foreground">
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
        <TextLink asChild size="small" color="neutral" icon={<ArrowLeft className="size-3.5" />}>
          <button type="button" onClick={() => setPicked(null)}>
            {t(M['gallery.back'])}
          </button>
        </TextLink>
        <div>
          <h3 className="text-[18px] font-semibold">{title}</h3>
          {text?.summary ? <p className="mt-1 text-sm text-muted-foreground">{text.summary}</p> : null}
          {payload.kind === 'form' ? <p className="mt-1 text-[12px] text-text-subtle">{t(M['gallery.minutes'], { n: payload.estimatedMinutes })}</p> : null}
        </div>
        {variables.length ? (
          <fieldset className="space-y-3">
            <legend className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{t(M['gallery.answers'])}</legend>
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
        <p className="text-[12px] text-text-subtle sm:col-span-2">{t(M['gallery.hidden'], { n: forms.length - usable.length })}</p>
      ) : null}
      {usable.map((tpl) => {
        const text = localizationOf(tpl.file, GALLERY_LOCALE);
        const payload = tpl.file.payload;
        const fields = payload.kind === 'form' ? Object.values(payload.document.blocks).filter((b) => b !== undefined && 'compliance' in b).length : 0;
        return (
          <Button key={tpl.entry.slug} type="button" variant="outline" onClick={() => pick(tpl)} className="h-auto flex-col items-start gap-1 whitespace-normal p-4 text-left">
            <span className="font-medium">{text?.title ?? tpl.entry.slug}</span>
            <span className="text-sm font-normal text-muted-foreground">{text?.summary}</span>
            {fields ? <span className="mt-1 text-[12px] font-normal text-text-subtle">{t(M['gallery.fields'], { n: fields })}</span> : null}
          </Button>
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
        {hint ? <p className="text-[12px] text-muted-foreground">{hint}</p> : null}
      </div>
    );
  }
  if (variable.type === 'select' && variable.options) {
    return (
      <Field label={label} hint={hint}>
        <NiceSelect
          aria-label={label}
          value={String(value ?? '')}
          onChange={onChange}
          options={variable.options.map((o) => ({ value: o.value, label: o.label }))}
          placeholder=" "
        />
      </Field>
    );
  }
  return (
    <Field label={label} hint={hint}>
      <Input
        type={variable.type === 'number' ? 'number' : variable.type === 'date' ? 'date' : variable.type === 'email' ? 'email' : variable.type === 'url' ? 'url' : 'text'}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(variable.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
      />
    </Field>
  );
}
