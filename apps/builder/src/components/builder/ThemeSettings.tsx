import { useState } from 'react';
import { defineMessages } from '@form/i18n';
import { isSafeUrl, type ConfettiStyle, type Ending, type EndingId, type FormDefinition, type RichDoc } from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { labelString } from '@/fields/style';
import { APP_IDS, blankDefinition, isField, richDoc } from '@/lib/definition';
import { payloadPreview } from '@/lib/payloadBody';
import { setBehavior, setEndings } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { updateOps, useOpsStore, type SubmissionApi, type SubmissionApiKey } from '@/state/opsStore';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Label, Switch } from '@dmacq/ui';
import { RichEditor } from '@/components/editor/RichEditor';
import { cn } from '@/lib/utils';
import { NiceSelect } from '@/components/NiceSelect';

const CONFETTI_STYLES: ConfettiStyle[] = ['classic', 'pastel', 'ocean', 'sunset'];
const CONFETTI_LABEL: Record<ConfettiStyle, 'settings.confetti_classic' | 'settings.confetti_pastel' | 'settings.confetti_ocean' | 'settings.confetti_sunset'> = {
  classic: 'settings.confetti_classic',
  pastel: 'settings.confetti_pastel',
  ocean: 'settings.confetti_ocean',
  sunset: 'settings.confetti_sunset',
};

const M = defineMessages('builder', {
  'settings.title': 'Customize',
  'settings.description': 'Theme and form settings.',
  'settings.form': 'Form settings',
  'settings.submit': 'Submit button',
  'settings.thanks': 'Thank-you message',
  'settings.redirect': 'Redirect after submit',
  'settings.redirect_hint': 'An https address; leave empty to show the thank-you message',
  'settings.redirect_invalid': 'Use an https address',
  'settings.confetti': 'Confetti on submit',
  'settings.confetti_style': 'Confetti style',
  'settings.confetti_classic': 'Classic',
  'settings.confetti_pastel': 'Hearts',
  'settings.confetti_ocean': 'Ocean',
  'settings.confetti_sunset': 'Crackers',
  'settings.closed': 'Close form',
  'settings.closed_message': 'Closed message',
  'settings.password': 'Password (optional)',
  'settings.password_hint': 'Kept in this browser for the preview; the server hashes it when forms are saved there.',
  'settings.api': 'Send answers to an API',
  'settings.api_url': 'API URL',
  'settings.api_format': 'Body format',
  'settings.api_format_json': 'JSON',
  'settings.api_format_xml': 'XML',
  'settings.api_path': 'API path',
  'settings.api_field': 'Form field',
  'settings.api_add': 'Add key',
  'settings.api_remove': 'Remove',
  'settings.api_hint': 'Type the path the API expects. Dots nest objects. lines[].item repeats once per table row.',
  'settings.api_part': 'Part',
  'settings.api_whole': 'Whole field',
  'settings.api_column': 'Column {name}',
  'settings.api_summary': 'Summary {name}',
  'settings.api_first': 'First name',
  'settings.api_last': 'Last name',
  'settings.api_preview': 'Body this typing creates',
  'settings.api_invalid': 'These paths are not valid: {paths}',
  'settings.api_none': 'No field',
  'form.submit_label': 'Submit',
});

type MessageEnding = Extract<Ending, { kind: 'message' }>;

const messageEnding = (def: FormDefinition): MessageEnding | undefined => def.endings.find((e): e is MessageEnding => e.kind === 'message');

/** The redirect URL of the default ending, when it is a plain https redirect. */
const redirectOf = (def: FormDefinition): string => {
  const ending = def.endings.find((e) => e.id === def.defaultEndingId);
  return ending?.kind === 'redirect' ? labelString(ending.url) : '';
};

/**
 * Endings with `url` as the default redirect. An empty url removes it and the message ending is the default again; a
 * form that has none gets the blank form's thank-you message.
 */
function withRedirect(def: FormDefinition, url: string): { endings: Ending[]; defaultEndingId: EndingId } {
  const message = messageEnding(def);
  const others = def.endings.filter((e) => e.kind !== 'redirect' || e.id !== def.defaultEndingId);
  if (!url) {
    if (message) return { endings: others, defaultEndingId: message.id };
    const thanks = { ...(messageEnding(blankDefinition(def.formId)) as MessageEnding), id: APP_IDS.newId() as EndingId };
    return { endings: [...others, thanks], defaultEndingId: thanks.id };
  }
  const current = def.endings.find((e) => e.id === def.defaultEndingId && e.kind === 'redirect');
  const id = (current?.id ?? APP_IDS.newId()) as EndingId;
  const redirect: Ending = { id, kind: 'redirect', name: t(M['settings.redirect']), url: [url], ...(message ? { message: message.content } : {}) };
  return { endings: [...others, redirect], defaultEndingId: id };
}

export function ThemeSettings({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t(M['settings.title'])}</DialogTitle>
            <DialogDescription>{t(M['settings.description'])}</DialogDescription>
          </DialogHeader>
          <SubmissionSettings />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** Submit, ending, close and optional password. Empty password means none. */
export function SubmissionSettings({ dark = false }: { dark?: boolean }) {
  const def = useDoc((d) => d);
  const ops = useOpsStore();
  const message = messageEnding(def);
  const [redirect, setRedirect] = useDraft(redirectOf(def));
  const redirectValid = redirect === '' || (isSafeUrl(redirect) && /^https:/i.test(redirect));
  /* The button needs a label: an emptied field keeps the last one until the author types another. */
  const [submit, setSubmit] = useState(labelString(def.behavior.submit.label));

  const setThanks = (content: RichDoc) => {
    if (!message) return;
    setEndings(def.endings.map((e) => (e.id === message.id ? { ...message, content } : e.kind === 'redirect' ? { ...e, message: content } : e)), def.defaultEndingId);
  };
  /* The behaviour flag and the message ending's confetti change together, in one undo step. */
  const setConfetti = (on: boolean) =>
    setEndings(def.endings.map((e) => (e.id === message?.id ? { ...message, confetti: on } : e)), def.defaultEndingId, { ...def.behavior, successAnimation: on });

  const field = dark ? 'border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground' : undefined;
  const labelCls = dark ? 'text-sidebar-foreground/80' : undefined;
  const hintCls = redirectValid ? 'text-[12px] text-muted-foreground' : 'text-[12px] text-destructive';

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="submit-label" className={labelCls}>{t(M['settings.submit'])}</Label>
        <Input
          id="submit-label"
          className={field}
          value={submit}
          onChange={(e) => {
            const v = e.target.value;
            setSubmit(v);
            if (v.trim()) setBehavior({ ...def.behavior, submit: { ...def.behavior.submit, label: v } });
          }}
          onBlur={() => {
            if (submit.trim()) return;
            const fallback = t(M['form.submit_label']);
            setSubmit(fallback);
            setBehavior({ ...def.behavior, submit: { ...def.behavior.submit, label: fallback } });
          }}
        />
      </div>
      {message ? (
        <div className="space-y-1.5">
          <Label className={labelCls}>{t(M['settings.thanks'])}</Label>
          <div className={cn('rounded-md border px-2', dark ? 'border-sidebar-border bg-sidebar-accent/40' : 'border-border')}>
            <RichEditor value={message.content} onChange={setThanks} className="text-sm leading-6" placeholder={t(M['settings.thanks'])} />
          </div>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="redirect" className={labelCls}>{t(M['settings.redirect'])}</Label>
        <Input
          id="redirect"
          className={field}
          value={redirect}
          placeholder="https://…"
          onChange={(e) => {
            const url = e.target.value.trim();
            setRedirect(e.target.value);
            if (url === '' || (isSafeUrl(url) && /^https:/i.test(url))) {
              const next = withRedirect(def, url);
              setEndings(next.endings, next.defaultEndingId);
            }
          }}
        />
        <p className={hintCls}>{t(redirectValid ? M['settings.redirect_hint'] : M['settings.redirect_invalid'])}</p>
      </div>
      <Toggle dark={dark} id="successAnimation" label={t(M['settings.confetti'])} checked={def.behavior.successAnimation} onChange={setConfetti} />
      {def.behavior.successAnimation && message ? (
        <div className="space-y-1.5">
          <Label htmlFor="confetti-style" className={labelCls}>{t(M['settings.confetti_style'])}</Label>
          <NiceSelect
            value={message.confettiStyle ?? 'classic'}
            onChange={(v) => setEndings(def.endings.map((e) => (e.id === message.id ? { ...message, confettiStyle: v as ConfettiStyle } : e)), def.defaultEndingId)}
            options={CONFETTI_STYLES.map((s) => ({ value: s, label: t(M[CONFETTI_LABEL[s]]) }))}
            aria-label={t(M['settings.confetti_style'])}
          />
        </div>
      ) : null}
      <Toggle dark={dark} id="closed" label={t(M['settings.closed'])} checked={!ops.open} onChange={(closed) => updateOps({ open: !closed })} />
      {!ops.open ? (
        <div className="space-y-1.5">
          <Label className={labelCls}>{t(M['settings.closed_message'])}</Label>
          <div className={cn('rounded-md border px-2', dark ? 'border-sidebar-border bg-sidebar-accent/40' : 'border-border')}>
            <RichEditor value={ops.closedMessage.content.length ? ops.closedMessage : richDoc('')} onChange={(closedMessage) => updateOps({ closedMessage })} className="text-sm leading-6" />
          </div>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="password" className={labelCls}>{t(M['settings.password'])}</Label>
        <Input id="password" type="password" autoComplete="new-password" className={field} value={ops.password} placeholder="" onChange={(e) => updateOps({ password: e.target.value.slice(0, 200) })} />
        <p className="text-[12px] text-muted-foreground">{t(M['settings.password_hint'])}</p>
      </div>
      <SubmissionApiSettings dark={dark} field={field} labelCls={labelCls} />
    </div>
  );
}

/** URL, JSON or XML, and a live body built from the paths as they are typed. */
function SubmissionApiSettings({ dark, field, labelCls }: { dark: boolean; field: string | undefined; labelCls: string | undefined }) {
  const def = useDoc((d) => d);
  const api = useOpsStore((s) => s.submissionApi);
  const setApi = (patch: Partial<SubmissionApi>) => updateOps({ submissionApi: { ...api, ...patch } });
  const fields = Object.values(def.blocks).flatMap((block) => {
    if (!isField(block)) return [];
    const text = typeof block.label === 'string' || Array.isArray(block.label) ? labelString(block.label) : '';
    const parts: Array<{ value: string; label: string }> = [{ value: '', label: t(M['settings.api_whole']) }];
    if (block.type === 'dynamic_table') {
      const columns = (block.config as { columns?: Array<{ label?: unknown; summary?: string; summaryLabel?: string }> }).columns ?? [];
      for (const column of columns) {
        const name = (typeof column.label === 'string' ? column.label : '') || 'Column';
        parts.push({ value: `column:${name}`, label: t(M['settings.api_column'], { name }) });
        if (column.summary && column.summary !== 'none') {
          const summary = column.summaryLabel?.trim() || `${name} ${column.summary}`;
          parts.push({ value: `summary:${summary}`, label: t(M['settings.api_summary'], { name: summary }) });
        }
      }
    }
    if (block.type === 'full_name') {
      parts.push({ value: 'name:first', label: t(M['settings.api_first']) }, { value: 'name:last', label: t(M['settings.api_last']) });
    }
    return [{ value: block.key, label: text || block.key, type: block.type, parts }];
  });
  const preview = payloadPreview(
    api.format,
    api.keys.map((key) => {
      const field = fields.find((item) => item.value === key.fieldKey);
      return { path: key.path, sample: previewSample(field, key.part) };
    }),
  );

  const setKey = (index: number, patch: Partial<SubmissionApiKey>) => {
    const keys = api.keys.map((key, i) => (i === index ? { ...key, ...patch } : key));
    setApi({ keys });
  };

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <Toggle dark={dark} id="submission-api" label={t(M['settings.api'])} checked={api.enabled} onChange={(enabled) => setApi({ enabled })} />
      <div className="space-y-1.5">
        <Label htmlFor="api-url" className={labelCls}>{t(M['settings.api_url'])}</Label>
        <Input id="api-url" className={field} value={api.url} placeholder="https://…" onChange={(e) => setApi({ url: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label className={labelCls}>{t(M['settings.api_format'])}</Label>
        <NiceSelect
          value={api.format}
          onChange={(format) => setApi({ format: format === 'xml' ? 'xml' : 'json' })}
          options={[
            { value: 'json', label: t(M['settings.api_format_json']) },
            { value: 'xml', label: t(M['settings.api_format_xml']) },
          ]}
          aria-label={t(M['settings.api_format'])}
        />
      </div>
      <p className="text-[12px] text-muted-foreground">{t(M['settings.api_hint'])}</p>
      {api.keys.map((key, index) => (
        <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <Input
            aria-label={t(M['settings.api_path'])}
            className={field}
            value={key.path}
            placeholder="customer.name"
            onChange={(e) => setKey(index, { path: e.target.value })}
          />
          <NiceSelect
            value={key.fieldKey}
            onChange={(fieldKey) => setKey(index, { fieldKey, part: '' })}
            options={[{ value: '', label: t(M['settings.api_none']) }, ...fields]}
            aria-label={t(M['settings.api_field'])}
          />
          {(fields.find((item) => item.value === key.fieldKey)?.parts.length ?? 0) > 1 ? (
            <NiceSelect
              value={key.part}
              onChange={(part) => setKey(index, { part })}
              options={fields.find((item) => item.value === key.fieldKey)?.parts ?? []}
              aria-label={t(M['settings.api_part'])}
            />
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => setApi({ keys: api.keys.filter((_, i) => i !== index) })}>
            {t(M['settings.api_remove'])}
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => setApi({ keys: [...api.keys, { path: '', fieldKey: '', part: '', required: true }] })}>
        {t(M['settings.api_add'])}
      </Button>
      <div className="space-y-1.5">
        <Label className={labelCls}>{t(M['settings.api_preview'])}</Label>
        <pre className={cn('overflow-x-auto rounded-md border p-2 text-[12px] leading-5', dark ? 'border-sidebar-border bg-sidebar-accent/40' : 'border-border bg-muted/40')}>{preview.text}</pre>
        {preview.invalid.length ? <p className="text-[12px] text-destructive">{t(M['settings.api_invalid'], { paths: preview.invalid.join(', ') })}</p> : null}
      </div>
    </div>
  );
}

function previewSample(field: { label: string; type: string; parts: Array<{ value: string; label: string }> } | undefined, part: string): unknown {
  if (!field) return '…';
  if (field.type === 'dynamic_table') {
    const columns = field.parts.filter((item) => item.value.startsWith('column:')).map((item) => item.value.slice('column:'.length));
    const summaries = field.parts.filter((item) => item.value.startsWith('summary:')).map((item) => item.value.slice('summary:'.length));
    const row = (first: string, second: string) => Object.fromEntries(columns.map((name, index) => [name, index === 0 ? first : second]));
    const whole = {
      rows: [row('Pen', '10'), row('Book', '20')],
      ...(summaries.length ? { summary: Object.fromEntries(summaries.map((name) => [name, 30])) } : {}),
    };
    if (part.startsWith('column:')) return whole.rows.map((item) => item[part.slice('column:'.length)] ?? '');
    if (part.startsWith('summary:')) return whole.summary?.[part.slice('summary:'.length)] ?? '';
    return whole;
  }
  if (part === 'name:first') return 'Lokesh';
  if (part === 'name:last') return 'K';
  return field.label || '…';
}

function Toggle({ id, label, checked, onChange, dark }: { id: string; label: string; checked: boolean; onChange: (on: boolean) => void; dark?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className={dark ? 'text-sidebar-foreground/80' : undefined}>{label}</Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

