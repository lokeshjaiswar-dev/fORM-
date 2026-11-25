import { useId } from 'react';
import { defineMessages } from '@form/i18n';
import { Button, Input, RadioField, RadioGroup, Switch, Label } from '@dmacq/ui';
import { t } from '@/i18n';
import type { FormField } from '@/components/settings/webhookForm';
import { META_NAMES, mappingOf, previewOf, type BodyValues, type MappingRow } from '@/components/settings/webhookBody';

const M = defineMessages('builder', {
  'webhooks.body.format': 'Body format',
  'webhooks.body.format_json': 'JSON',
  'webhooks.body.format_xml': 'XML',
  'webhooks.body.custom': 'Choose the shape of the body myself',
  'webhooks.body.custom_hint': 'Off, the standard payload is sent. On, only the values you map below are sent, at the paths you give them. Purposes and masking still apply: a field the webhook may not receive stays out, and a masked one stays masked.',
  'webhooks.body.root': 'XML root element',
  'webhooks.body.path': 'Path',
  'webhooks.body.path_hint': 'customer.name or order.lines[].item',
  'webhooks.body.source_kind': 'Source',
  'webhooks.body.kind_answer': 'An answer',
  'webhooks.body.kind_meta': 'Response detail',
  'webhooks.body.field': 'Field',
  'webhooks.body.pick': 'Pick a field',
  'webhooks.body.detail': 'Detail',
  'webhooks.body.add': 'Add a value',
  'webhooks.body.remove': 'Remove',
  'webhooks.body.spread_hint': 'A [] in a path spreads a list answer, one item per entry.',
  'webhooks.body.preview': 'Preview with sample values',
  'webhooks.body.empty': 'Add at least one value to map.',
  'webhooks.body.meta.event': 'Event name',
  'webhooks.body.meta.eventId': 'Event id',
  'webhooks.body.meta.createdAt': 'Event time',
  'webhooks.body.meta.formId': 'Form id',
  'webhooks.body.meta.submissionId': 'Response id',
  'webhooks.body.meta.submittedAt': 'Response time',
});

const META_LABELS = {
  event: M['webhooks.body.meta.event'],
  eventId: M['webhooks.body.meta.eventId'],
  createdAt: M['webhooks.body.meta.createdAt'],
  formId: M['webhooks.body.meta.formId'],
  submissionId: M['webhooks.body.meta.submissionId'],
  submittedAt: M['webhooks.body.meta.submittedAt'],
} as const;

const CONTROL = 'h-9 rounded-[8px] border border-border-control bg-background px-2 text-[13px] text-foreground';

export interface WebhookBodyEditorProps {
  value: BodyValues;
  fields: readonly FormField[];
  onChange: (change: Partial<BodyValues>) => void;
}

/**
 * The body of a webhook (INT-01): its format, and optionally a mapping of paths to answers with a live preview. The preview
 * is made from sample values by the same code the worker runs, so it shows the shape and never a real answer.
 */
export function WebhookBodyEditor({ value, fields, onChange }: WebhookBodyEditorProps) {
  const ids = useId();
  const legend = 'mb-1.5 text-[13px] font-medium text-foreground';
  const hint = 'text-[13px] text-muted-foreground';
  const mapping = mappingOf(value.rows, value.format === 'xml' ? value.root : '');
  const preview = value.custom ? previewOf(value.format, mapping, fields) : null;
  const setRow = (index: number, change: Partial<MappingRow>) => onChange({ rows: value.rows.map((r, i) => (i === index ? { ...r, ...change } : r)) });

  return (
    <div className="flex flex-col gap-3">
      <RadioGroup aria-labelledby={`${ids}-format`} value={value.format} onValueChange={(v) => onChange({ format: v === 'xml' ? 'xml' : 'json' })} className="flex flex-col gap-1.5">
        <p id={`${ids}-format`} className={legend}>
          {t(M['webhooks.body.format'])}
        </p>
        <RadioField value="json" label={t(M['webhooks.body.format_json'])} />
        <RadioField value="xml" label={t(M['webhooks.body.format_xml'])} />
      </RadioGroup>

      <div className="flex items-center gap-3">
        <Switch id={`${ids}-custom`} checked={value.custom} onCheckedChange={(custom) => onChange({ custom })} />
        <Label htmlFor={`${ids}-custom`}>{t(M['webhooks.body.custom'])}</Label>
      </div>
      <p className={hint}>{t(M['webhooks.body.custom_hint'])}</p>

      {value.custom ? (
        <div className="flex flex-col gap-3">
          {value.format === 'xml' ? (
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="font-medium">{t(M['webhooks.body.root'])}</span>
              <Input value={value.root} placeholder="submission" spellCheck={false} onChange={(e) => onChange({ root: e.target.value })} />
            </label>
          ) : null}

          {value.rows.map((row, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2" role="group" aria-label={`${t(M['webhooks.body.path'])} ${index + 1}`}>
              <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-[13px]">
                <span className="font-medium">{t(M['webhooks.body.path'])}</span>
                <Input value={row.path} placeholder={t(M['webhooks.body.path_hint'])} spellCheck={false} autoComplete="off" onChange={(e) => setRow(index, { path: e.target.value })} />
              </label>
              <label className="flex flex-col gap-1 text-[13px]">
                <span className="font-medium">{t(M['webhooks.body.source_kind'])}</span>
                <select className={CONTROL} value={row.kind} onChange={(e) => setRow(index, { kind: e.target.value === 'meta' ? 'meta' : 'answer', ref: '' })}>
                  <option value="answer">{t(M['webhooks.body.kind_answer'])}</option>
                  <option value="meta">{t(M['webhooks.body.kind_meta'])}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[13px]">
                <span className="font-medium">{t(row.kind === 'answer' ? M['webhooks.body.field'] : M['webhooks.body.detail'])}</span>
                <select className={CONTROL} value={row.ref} onChange={(e) => setRow(index, { ref: e.target.value })}>
                  <option value="">{t(M['webhooks.body.pick'])}</option>
                  {row.kind === 'answer'
                    ? [...fields, ...(row.ref && !fields.some((f) => f.key === row.ref) ? [{ key: row.ref, label: row.ref }] : [])].map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label} ({f.key})
                        </option>
                      ))
                    : META_NAMES.map((name) => (
                        <option key={name} value={name}>
                          {t(META_LABELS[name])}
                        </option>
                      ))}
                </select>
              </label>
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ rows: value.rows.filter((_, i) => i !== index) })}>
                {t(M['webhooks.body.remove'])}
              </Button>
            </div>
          ))}

          <div className="flex items-center gap-3">
            <Button type="button" variant="secondary" size="sm" onClick={() => onChange({ rows: [...value.rows, { path: '', kind: 'answer', ref: '' }] })}>
              {t(M['webhooks.body.add'])}
            </Button>
            <span className={hint}>{t(M['webhooks.body.spread_hint'])}</span>
          </div>

          {preview && preview.issues.length > 0 ? (
            <ul role="alert" className="list-disc pl-5 text-[13px] text-destructive">
              {preview.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
          {mapping.entries.length === 0 && value.rows.length === 0 ? <p className={hint}>{t(M['webhooks.body.empty'])}</p> : null}

          {preview && preview.issues.length === 0 && mapping.entries.length > 0 ? (
            <div>
              <p className={legend}>{t(M['webhooks.body.preview'])}</p>
              <pre aria-label={t(M['webhooks.body.preview'])} className="max-h-72 overflow-auto rounded-md border border-border bg-muted p-3 text-[12px]">
                {preview.text}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
