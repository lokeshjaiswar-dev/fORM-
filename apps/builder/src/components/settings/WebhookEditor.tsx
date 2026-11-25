import { useId, useState } from 'react';
import { defineMessages } from '@form/i18n';
import { Alert, AlertDescription, Button, CheckboxField, Field, Input, Label, RadioField, RadioGroup, Switch } from '@dmacq/ui';
import { t } from '@/i18n';
import { ApiProblem } from '@/auth/client';
import { type FormFacts } from '@/components/settings/webhookForm';
import { bodyIsSaveable, mappingOf, rowsOf, type BodyValues } from '@/components/settings/webhookBody';
import { WebhookBodyEditor } from '@/components/settings/WebhookBodyEditor';
import { EVENT_LABELS, describeWebhookFailure, isForbidden } from '@/components/settings/webhookText';
import {
  ALL_IN_PURPOSES,
  WebhookConflict,
  createWebhook,
  saveWebhook,
  type CreatedWebhook,
  type Webhook,
  type WebhookEvent,
  type WebhookInput,
} from '@/persistence/webhooksApi';

const M = defineMessages('builder', {
  'webhooks.editor.title_new': 'Add a webhook',
  'webhooks.editor.title_edit': 'Change this webhook',
  'webhooks.editor.url': 'Address',
  'webhooks.editor.url_hint': 'Each response is posted here as JSON or XML, signed so your receiver can check it came from fORM-.',
  'webhooks.editor.url_placeholder': 'https://example.com/hooks/form',
  'webhooks.editor.enabled': 'Send responses to this address',
  'webhooks.editor.events': 'Send when',
  'webhooks.editor.events_none': 'Choose at least one event.',
  'webhooks.editor.event_not_sent': 'not sent yet',
  'webhooks.editor.purposes': 'Purposes',
  'webhooks.editor.purposes_hint': 'Answers leave fORM- only for the purposes you tick, and only those the form declares. Sending them to an outside address counts as sharing them.',
  'webhooks.editor.purposes_none': 'Choose at least one purpose.',
  'webhooks.editor.purposes_empty': 'This form declares no purposes yet. Add one under the form’s privacy settings, then come back.',
  'webhooks.editor.purposes_unread': 'The form’s purposes could not be read. Open the form in the builder so it saves, then reload this page.',
  'webhooks.editor.purpose_undeclared': 'no longer declared in the form',
  'webhooks.editor.fields': 'Fields sent',
  'webhooks.editor.fields_all': 'Every field covered by the purposes above',
  'webhooks.editor.fields_picked': 'Only the fields I pick',
  'webhooks.editor.fields_none': 'Pick at least one field, or send every field covered by the purposes.',
  'webhooks.editor.fields_pick': 'Fields to send',
  'webhooks.editor.field_gone': 'not in the form',
  'webhooks.editor.key_by': 'Name the answers by',
  'webhooks.editor.key_by_key': 'Field key (for example full_name)',
  'webhooks.editor.key_by_id': 'Field id',
  'webhooks.editor.create': 'Create webhook',
  'webhooks.editor.save': 'Save webhook',
  'webhooks.editor.cancel': 'Cancel',
  'webhooks.editor.egress': 'That address cannot be reached from this installation.',
  'webhooks.editor.missing_purpose': 'Choose a purpose the form declares.',
  'webhooks.editor.save_failed': 'The webhook could not be saved. Check the settings and try again.',
  'webhooks.editor.conflict': 'This webhook was changed somewhere else, so yours was not saved. Reload to see it as it is now, then make your change again.',
  'webhooks.editor.reload': 'Reload',
});

/** The events the worker sends today. The rest the API accepts, but nothing raises them yet, so they are not offered for a new choice. */
const OFFERED: readonly WebhookEvent[] = ['submission.created', 'submission.updated'];

interface Values {
  url: string;
  enabled: boolean;
  events: WebhookEvent[];
  keyBy: 'key' | 'id';
  allFields: boolean;
  fieldKeys: string[];
  purposeIds: string[];
  body: BodyValues;
}

function valuesOf(webhook: Webhook | null): Values {
  if (!webhook) return { url: '', enabled: true, events: ['submission.created'], keyBy: 'key', allFields: true, fieldKeys: [], purposeIds: [], body: { format: 'json', custom: false, root: '', rows: [] } };
  return {
    url: webhook.url,
    enabled: webhook.enabled,
    events: webhook.events,
    keyBy: webhook.keyBy,
    allFields: webhook.fieldKeys === ALL_IN_PURPOSES,
    fieldKeys: webhook.fieldKeys === ALL_IN_PURPOSES ? [] : webhook.fieldKeys,
    purposeIds: webhook.purposeIds,
    body: { format: webhook.bodyFormat, custom: webhook.payloadMapping !== null, root: webhook.payloadMapping?.root ?? '', rows: rowsOf(webhook.payloadMapping) },
  };
}

/** Whether `text` is a web address the server could look at: http or https, with a host. The server decides the rest (its edition's scheme, the allowlist, private addresses). */
function isWebAddress(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '';
  } catch {
    return false;
  }
}

const toggle = <T,>(list: readonly T[], item: T, on: boolean): T[] => (on ? (list.includes(item) ? [...list] : [...list, item]) : list.filter((x) => x !== item));

interface Problems {
  url?: string | undefined;
  purposes?: string | undefined;
  general?: string | undefined;
  conflict?: boolean | undefined;
}

export interface WebhookEditorProps {
  org: string;
  formId: string;
  /** The webhook being changed; null makes a new one. */
  webhook: Webhook | null;
  /** The form's purposes and fields; null when its draft could not be read. */
  facts: FormFacts | null;
  onCreated: (created: CreatedWebhook) => void;
  onSaved: (webhook: Webhook) => void;
  onCancel: () => void;
  /** The API refused for want of `data.route`. */
  onForbidden: () => void;
  /** Someone else saved first: the caller reads the webhooks again. */
  onReload: () => void;
}

/**
 * The editor of one webhook (WP-1.18): address, events, the purposes it is sent for (at least one, each declared by the
 * form), which fields, how answers are named, and whether it is on. Save stays off until the settings could be accepted: an
 * address, an event, a purpose, and fields when they are picked. The server checks them again, and what it refuses is shown
 * next to the control it is about: a 422 `EGRESS_DENIED` beside the address, a 422 `MISSING_PURPOSE` beside the purposes.
 */
export function WebhookEditor({ org, formId, webhook, facts, onCreated, onSaved, onCancel, onForbidden, onReload }: WebhookEditorProps) {
  const ids = useId();
  const [values, setValues] = useState<Values>(() => valuesOf(webhook));
  const [problems, setProblems] = useState<Problems>({});
  const [busy, setBusy] = useState(false);
  const set = (change: Partial<Values>) => setValues((current) => ({ ...current, ...change }));

  const declared = facts?.purposes ?? [];
  // A purpose the webhook names that the form no longer declares stays listed, so it can be seen and unticked.
  const stale = values.purposeIds.filter((id) => !declared.some((p) => p.id === id));
  const purposeOptions = [...declared.map((p) => ({ id: p.id, name: p.name, undeclared: false })), ...stale.map((id) => ({ id, name: id, undeclared: true }))];
  const fields = facts?.fields ?? [];
  const missingFields = values.fieldKeys.filter((key) => !fields.some((f) => f.key === key));
  const fieldOptions = [...fields.map((f) => ({ ...f, gone: false })), ...missingFields.map((key) => ({ key, label: key, gone: true }))];
  const eventOptions = [...OFFERED, ...values.events.filter((event) => !OFFERED.includes(event))];

  const addressOk = isWebAddress(values.url);
  const fieldsOk = values.allFields || values.fieldKeys.length > 0;
  const canSave = addressOk && values.events.length > 0 && values.purposeIds.length > 0 && fieldsOk && bodyIsSaveable(values.body, fields) && !busy;

  async function submit() {
    if (!canSave) return;
    const input: WebhookInput = {
      url: values.url.trim(),
      enabled: values.enabled,
      events: values.events,
      keyBy: values.keyBy,
      fieldKeys: values.allFields ? ALL_IN_PURPOSES : values.fieldKeys,
      purposeIds: values.purposeIds,
      // Signed file links are not sent yet, so a new webhook asks for none and a saved one keeps what it had.
      files: webhook?.files ?? 'none',
      bodyFormat: values.body.format,
      payloadMapping: values.body.custom ? mappingOf(values.body.rows, values.body.format === 'xml' ? values.body.root : '') : null,
    };
    setBusy(true);
    setProblems({});
    try {
      if (webhook) onSaved(await saveWebhook(org, formId, webhook.id, input, webhook.rev));
      else onCreated(await createWebhook(org, formId, input));
    } catch (err) {
      setBusy(false);
      if (isForbidden(err)) return onForbidden();
      if (err instanceof WebhookConflict) return setProblems({ conflict: true });
      if (err instanceof ApiProblem && err.code === 'EGRESS_DENIED') return setProblems({ url: err.message || t(M['webhooks.editor.egress']) });
      if (err instanceof ApiProblem && err.code === 'INVALID_PAYLOAD_MAPPING') return setProblems({ general: err.message });
      if (err instanceof ApiProblem && err.code === 'MISSING_PURPOSE') return setProblems({ purposes: err.message || t(M['webhooks.editor.missing_purpose']) });
      setProblems({ general: describeWebhookFailure(err, M['webhooks.editor.save_failed']) });
    }
  }

  const legend = 'mb-1.5 text-[13px] font-medium text-foreground';
  const hint = 'text-[13px] text-muted-foreground';
  const purposesDescribedBy = [`${ids}-purposes-hint`, problems.purposes ? `${ids}-purposes-error` : null, values.purposeIds.length === 0 ? `${ids}-purposes-none` : null].filter(Boolean).join(' ');

  return (
    <form
      className="flex flex-col gap-5 rounded-lg border border-border bg-background p-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-[16px] font-semibold">{t(webhook ? M['webhooks.editor.title_edit'] : M['webhooks.editor.title_new'])}</h3>

      <Field label={t(M['webhooks.editor.url'])} hint={t(M['webhooks.editor.url_hint'])} {...(problems.url ? { error: problems.url } : {})}>
        <Input
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={t(M['webhooks.editor.url_placeholder'])}
          value={values.url}
          onChange={(event) => {
            set({ url: event.target.value });
            setProblems((current) => ({ ...current, url: undefined }));
          }}
        />
      </Field>

      <div className="flex items-center gap-3">
        <Switch id={`${ids}-enabled`} checked={values.enabled} onCheckedChange={(enabled) => set({ enabled })} />
        <Label htmlFor={`${ids}-enabled`}>{t(M['webhooks.editor.enabled'])}</Label>
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className={legend}>{t(M['webhooks.editor.events'])}</legend>
        {eventOptions.map((event) => (
          <CheckboxField
            key={event}
            label={
              OFFERED.includes(event) ? t(EVENT_LABELS[event]) : `${t(EVENT_LABELS[event])} (${t(M['webhooks.editor.event_not_sent'])})`
            }
            checked={values.events.includes(event)}
            onCheckedChange={(on) => set({ events: toggle(values.events, event, on === true) })}
          />
        ))}
        {values.events.length === 0 ? <p className={hint}>{t(M['webhooks.editor.events_none'])}</p> : null}
      </fieldset>

      <fieldset className="flex flex-col gap-1.5" aria-describedby={purposesDescribedBy}>
        <legend className={legend}>{t(M['webhooks.editor.purposes'])}</legend>
        <p id={`${ids}-purposes-hint`} className={hint}>
          {t(M['webhooks.editor.purposes_hint'])}
        </p>
        {purposeOptions.map((purpose) => (
          <CheckboxField
            key={purpose.id}
            label={purpose.undeclared ? `${purpose.name} (${t(M['webhooks.editor.purpose_undeclared'])})` : purpose.name}
            checked={values.purposeIds.includes(purpose.id)}
            onCheckedChange={(on) => {
              set({ purposeIds: toggle(values.purposeIds, purpose.id, on === true) });
              setProblems((current) => ({ ...current, purposes: undefined }));
            }}
          />
        ))}
        {facts === null ? (
          <p className={hint}>{t(M['webhooks.editor.purposes_unread'])}</p>
        ) : declared.length === 0 ? (
          <p className={hint}>{t(M['webhooks.editor.purposes_empty'])}</p>
        ) : null}
        {values.purposeIds.length === 0 ? (
          <p id={`${ids}-purposes-none`} className={hint}>
            {t(M['webhooks.editor.purposes_none'])}
          </p>
        ) : null}
        {problems.purposes ? (
          <p id={`${ids}-purposes-error`} role="alert" className="text-[13px] text-destructive">
            {problems.purposes}
          </p>
        ) : null}
      </fieldset>

      <RadioGroup
        aria-labelledby={`${ids}-fields`}
        value={values.allFields ? 'all' : 'picked'}
        onValueChange={(value) => set({ allFields: value === 'all' })}
        className="flex flex-col gap-1.5"
      >
        <p id={`${ids}-fields`} className={legend}>
          {t(M['webhooks.editor.fields'])}
        </p>
        <RadioField value="all" label={t(M['webhooks.editor.fields_all'])} />
        <RadioField value="picked" label={t(M['webhooks.editor.fields_picked'])} />
      </RadioGroup>
      {!values.allFields ? (
        <fieldset className="ml-6 flex flex-col gap-1.5">
          <legend className="sr-only">{t(M['webhooks.editor.fields_pick'])}</legend>
          {fieldOptions.map((field) => (
            <CheckboxField
              key={field.key}
              label={field.gone ? `${field.label} (${field.key}, ${t(M['webhooks.editor.field_gone'])})` : `${field.label} (${field.key})`}
              checked={values.fieldKeys.includes(field.key)}
              onCheckedChange={(on) => set({ fieldKeys: toggle(values.fieldKeys, field.key, on === true) })}
            />
          ))}
          {values.fieldKeys.length === 0 ? <p className={hint}>{t(M['webhooks.editor.fields_none'])}</p> : null}
        </fieldset>
      ) : null}

      <RadioGroup
        aria-labelledby={`${ids}-key-by`}
        value={values.keyBy}
        onValueChange={(value) => set({ keyBy: value === 'id' ? 'id' : 'key' })}
        className="flex flex-col gap-1.5"
      >
        <p id={`${ids}-key-by`} className={legend}>
          {t(M['webhooks.editor.key_by'])}
        </p>
        <RadioField value="key" label={t(M['webhooks.editor.key_by_key'])} />
        <RadioField value="id" label={t(M['webhooks.editor.key_by_id'])} />
      </RadioGroup>

      <WebhookBodyEditor value={values.body} fields={fields} onChange={(change) => set({ body: { ...values.body, ...change } })} />

      {problems.conflict ? (
        <Alert variant="warning" icon>
          <AlertDescription>
            <span className="block">{t(M['webhooks.editor.conflict'])}</span>
            <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={onReload}>
              {t(M['webhooks.editor.reload'])}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {problems.general ? (
        <Alert variant="destructive" icon>
          <AlertDescription>{problems.general}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t(M['webhooks.editor.cancel'])}
        </Button>
        <Button type="submit" disabled={!canSave}>
          {t(webhook ? M['webhooks.editor.save'] : M['webhooks.editor.create'])}
        </Button>
      </div>
    </form>
  );
}
