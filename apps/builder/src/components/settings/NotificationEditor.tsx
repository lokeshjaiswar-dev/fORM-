import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { defineMessages } from '@form/i18n';
import type { PurposeId } from '@form/schema';
import { Alert, AlertDescription, Button, CheckboxField, Input, Label, Switch } from '@dmacq/ui';
import { t } from '@/i18n';
import { NiceSelect } from '@/components/NiceSelect';
import { RichEditor } from '@/components/editor/RichEditor';
import { RecipientsEditor } from '@/components/settings/RecipientsEditor';
import { SubjectField } from '@/components/settings/SubjectField';
import {
  differs,
  formOf,
  hasAnswersTable,
  recipientsFor,
  richOf,
  undeclared,
  withAnswersTable,
  withRich,
  type DraftFacts,
} from '@/components/settings/notificationsModel';
import { problemText } from '@/pages/auth/util';
import type { EmailSender } from '@/persistence/emailSendersApi';
import {
  NotificationConflict,
  NotificationRefused,
  createNotification,
  saveNotification,
  type Notification,
  type NotificationForm,
  type OrgMember,
  type RefusalCode,
} from '@/persistence/notificationsApi';

const M = defineMessages('builder', {
  'notification_editor.name': 'Name',
  'notification_editor.name_hint': 'Only you see this name, in the list of emails.',
  'notification_editor.kind': 'Type',
  'notification_editor.kind_owner': 'Email to your team',
  'notification_editor.kind_autoresponder': 'Reply to the respondent',
  'notification_editor.enabled': 'Send this email',
  'notification_editor.trigger': 'Sent when someone submits the form.',
  'notification_editor.sender': 'Send from',
  'notification_editor.sender_platform': 'The platform’s own sender',
  'notification_editor.sender_gone': 'An email sender that is no longer here',
  'notification_editor.sender_unverified': 'This sender has not delivered a test message yet. Test it on the Email senders page.',
  'notification_editor.sender_link': 'Email senders',
  'notification_editor.recipients': 'Recipients',
  'notification_editor.purposes': 'Purposes',
  'notification_editor.purposes_hint': 'Required. Only answers collected for the purposes you tick go into this email; the others are left out.',
  'notification_editor.purposes_none': 'This form declares no purposes yet. Add one in the form’s privacy settings, then come back here.',
  'notification_editor.purpose_undeclared': '{name} (the form no longer declares this)',
  'notification_editor.purposes_needed': 'Tick at least one purpose to save.',
  'notification_editor.body': 'Message',
  'notification_editor.answers_table': 'Include answers table',
  'notification_editor.answers_table_hint': 'Lists the answers in this email’s purposes. Empty answers are left out and sensitive ones are masked.',
  'notification_editor.warnings': 'Things to fix in this email',
  'notification_editor.save': 'Save email',
  'notification_editor.saved': 'Email saved.',
  'notification_editor.back': 'Back to emails',
  'notification_editor.conflict': 'This email was changed somewhere else, so yours was not saved. Reload to see the current one, then make your changes again.',
  'notification_editor.reload': 'Reload',
  'notification_editor.refused_fields': 'The server did not accept this email: {detail}',
  'notification_editor.route': 'Saving needs permission to send answers outside: {detail}',
});

/** The part of the editor each refusal belongs next to; editing that part clears it. */
type Part = 'purposes' | 'recipients' | 'sender' | 'other';
const PART_CODES: Record<Part, readonly RefusalCode[]> = {
  purposes: ['MISSING_PURPOSE'],
  recipients: ['DATA_ROUTE_FORBIDDEN', 'RECIPIENT_NOT_FOUND'],
  sender: ['SENDER_NOT_FOUND'],
  other: ['NOTIFICATION_INVALID'],
};

/** A sender that is not the platform's: the value the select holds for "no sender". */
const PLATFORM = '__platform__';

interface Props {
  org: string;
  formId: string;
  /** The saved notification being edited; null for a new one. */
  notification: Notification | null;
  /** What a new email starts as (used when `notification` is null). */
  initial: NotificationForm;
  senders: readonly EmailSender[];
  members: readonly OrgMember[] | null;
  facts: DraftFacts;
  /** The notification as the server holds it after a save, so the list shows it. */
  onSaved: (saved: Notification) => void;
  /** Asks the panel to read everything again (after a conflict). */
  onReload: (id: string | null) => void;
  onClose: () => void;
}

/**
 * One email of a form: its name, type, sender, recipients, purposes, subject and message. Nothing here decides what is sent
 * to whom: the server checks the purposes against the form's draft (422), the sender and members against the org (422) and
 * the recipients against `data.route` (403), and each refusal is shown next to the part it is about. The purposes are
 * required, and Save stays off until one is ticked. The rev of the saved email is sent back in `If-Match`, so a save never
 * overwrites a change made somewhere else (409): the editor then offers to reload.
 */
export function NotificationEditor({ org, formId, notification, initial, senders, members, facts, onSaved, onReload, onClose }: Props) {
  const start = notification ? formOf(notification.config) : initial;
  // The id and revision of the saved email: a new one gets them with its first save, and the next save uses them.
  const [saved, setSaved] = useState<{ id: string; rev: number; form: NotificationForm } | null>(notification ? { id: notification.id, rev: notification.rev, form: start } : null);
  const [form, setForm] = useState<NotificationForm>(start);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<NotificationRefused | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState(notification?.warnings ?? []);

  /** Changes the form, and forgets the refusal that was about the part that changed: it may no longer be true. */
  const change = (next: (f: NotificationForm) => NotificationForm, part: Part) => {
    setForm(next);
    setNotice(null);
    setError(null);
    setRefusal((r) => (r && PART_CODES[part].includes(r.code) ? null : r));
  };
  const edit = (patch: Partial<NotificationForm>, part: Part) => change((f) => ({ ...f, ...patch }), part);

  const dirty = saved === null || differs(form, saved.form);
  const noPurpose = form.purposeIds.length === 0;
  const canSave = !busy && dirty && !noPurpose && form.name.trim() !== '';
  const stale = useMemo(() => undeclared(form.purposeIds, facts), [form.purposeIds, facts]);
  const rich = useMemo(() => richOf(form.body), [form.body]);
  const selectedSender = senders.find((s) => s.id === form.senderId);

  const togglePurpose = (id: string, on: boolean) => {
    const rest = form.purposeIds.filter((p) => p !== id);
    edit({ purposeIds: on ? [...rest, id as PurposeId] : rest }, 'purposes');
  };

  async function save() {
    setBusy(true);
    setError(null);
    setRefusal(null);
    setNotice(null);
    try {
      const sending: NotificationForm = { ...form, name: form.name.trim() };
      const result = saved ? await saveNotification(org, formId, saved.id, sending, saved.rev) : await createNotification(org, formId, sending);
      const now = formOf(result.config);
      setSaved({ id: result.id, rev: result.rev, form: now });
      setForm(now);
      setWarnings(result.warnings);
      setNotice(t(M['notification_editor.saved']));
      onSaved(result);
    } catch (err) {
      if (err instanceof NotificationConflict) setConflict(true);
      else if (err instanceof NotificationRefused) setRefusal(err);
      else setError(problemText(err));
    } finally {
      setBusy(false);
    }
  }

  const senderOptions = [
    { value: PLATFORM, label: t(M['notification_editor.sender_platform']) },
    ...senders.map((s) => ({ value: s.id, label: `${s.name} (${s.fromAddress})` })),
    ...(form.senderId && !selectedSender ? [{ value: form.senderId as string, label: t(M['notification_editor.sender_gone']) }] : []),
  ];
  const refusalAt = (...codes: RefusalCode[]) => (refusal && codes.includes(refusal.code) ? refusal : null);
  const purposeRefusal = refusalAt('MISSING_PURPOSE');
  const routeRefusal = refusalAt('DATA_ROUTE_FORBIDDEN', 'RECIPIENT_NOT_FOUND');
  const senderRefusal = refusalAt('SENDER_NOT_FOUND');
  const invalid = refusalAt('NOTIFICATION_INVALID');

  return (
    <form
      // The server and the editor decide what is valid, not the browser: with the address box inside this form, a half-typed
      // address (type=email) would otherwise stop Save with the browser's own tooltip.
      noValidate
      className="space-y-5"
      aria-label={form.name || t(M['notification_editor.name'])}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void save();
      }}
    >
      <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={onClose}>
        {t(M['notification_editor.back'])}
      </Button>

      {conflict ? (
        <Alert variant="warning" icon>
          <AlertDescription>
            {t(M['notification_editor.conflict'])}{' '}
            <Button type="button" size="sm" variant="outline" onClick={() => onReload(saved?.id ?? null)}>
              {t(M['notification_editor.reload'])}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="notification-name">{t(M['notification_editor.name'])}</Label>
          <Input id="notification-name" value={form.name} maxLength={200} onChange={(e) => edit({ name: e.target.value }, 'other')} />
          <p className="text-[12px] text-muted-foreground">{t(M['notification_editor.name_hint'])}</p>
        </div>
        <div className="space-y-1">
          <span className="block text-[13px] font-medium text-foreground">{t(M['notification_editor.kind'])}</span>
          <NiceSelect
            aria-label={t(M['notification_editor.kind'])}
            value={form.kind}
            onChange={(kind) => {
              if (kind !== 'owner' && kind !== 'autoresponder') return;
              // The recipients of one kind make no sense for the other: start the new kind with its own.
              edit({ kind, to: recipientsFor(kind, facts) }, 'recipients');
            }}
            options={[
              { value: 'owner', label: t(M['notification_editor.kind_owner']) },
              { value: 'autoresponder', label: t(M['notification_editor.kind_autoresponder']) },
            ]}
          />
          <p className="text-[12px] text-muted-foreground">{t(M['notification_editor.trigger'])}</p>
        </div>
      </div>

      <label className="flex items-center justify-between gap-3 text-[13px] font-medium text-foreground">
        {t(M['notification_editor.enabled'])}
        <Switch checked={form.enabled} onCheckedChange={(enabled) => edit({ enabled }, 'other')} aria-label={t(M['notification_editor.enabled'])} />
      </label>

      <div className="space-y-1">
        <span className="block text-[13px] font-medium text-foreground">{t(M['notification_editor.sender'])}</span>
        <div className="max-w-[420px]">
          <NiceSelect
            aria-label={t(M['notification_editor.sender'])}
            value={form.senderId ?? PLATFORM}
            onChange={(id) =>
              change((f) => {
                // No sender is a key left out, not an empty one: the platform's own sender is used.
                const { senderId: _drop, ...rest } = f;
                return id === PLATFORM ? rest : { ...rest, senderId: id as NonNullable<NotificationForm['senderId']> };
              }, 'sender')
            }
            options={senderOptions}
          />
        </div>
        {selectedSender && !selectedSender.verifiedAt ? (
          <p className="text-[12px] text-muted-foreground">
            {t(M['notification_editor.sender_unverified'])}{' '}
            <Link to="/org/email-senders" className="underline">
              {t(M['notification_editor.sender_link'])}
            </Link>
          </p>
        ) : null}
        {senderRefusal ? (
          <p role="alert" className="text-[13px] text-destructive">
            {senderRefusal.message}
          </p>
        ) : null}
      </div>

      <div role="group" aria-label={t(M['notification_editor.recipients'])} className="space-y-1">
        <RecipientsEditor kind={form.kind} value={form.to} onChange={(to) => edit({ to }, 'recipients')} members={members} facts={facts} />
        {routeRefusal ? (
          <p role="alert" className="text-[13px] text-destructive">
            {routeRefusal.code === 'DATA_ROUTE_FORBIDDEN' ? t(M['notification_editor.route'], { detail: routeRefusal.message }) : routeRefusal.message}
          </p>
        ) : null}
      </div>

      <fieldset className="space-y-2" aria-describedby="notification-purposes-hint">
        <legend className="text-[13px] font-medium text-foreground">{t(M['notification_editor.purposes'])}</legend>
        <p id="notification-purposes-hint" className="text-[12px] text-muted-foreground">
          {t(M['notification_editor.purposes_hint'])}
        </p>
        {facts.purposes.length === 0 && form.purposeIds.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t(M['notification_editor.purposes_none'])}</p>
        ) : null}
        {facts.purposes.map((p) => (
          <CheckboxField key={p.id} label={p.name} checked={form.purposeIds.includes(p.id as PurposeId)} onCheckedChange={(on) => togglePurpose(p.id, on === true)} />
        ))}
        {stale.map((id) => (
          <CheckboxField key={id} label={t(M['notification_editor.purpose_undeclared'], { name: id })} checked onCheckedChange={(on) => togglePurpose(id, on === true)} />
        ))}
        {purposeRefusal ? (
          <p role="alert" className="text-[13px] text-destructive">
            {purposeRefusal.message}
          </p>
        ) : noPurpose && facts.purposes.length > 0 ? (
          <p className="text-[12px] text-muted-foreground">{t(M['notification_editor.purposes_needed'])}</p>
        ) : null}
      </fieldset>

      <SubjectField value={form.subject} onChange={(subject) => edit({ subject }, 'other')} fields={facts.fields} />

      <div className="space-y-1.5">
        <span className="block text-[13px] font-medium text-foreground">{t(M['notification_editor.body'])}</span>
        <div className="rounded-md border border-border px-2 py-1">
          <RichEditor
            value={rich}
            onChange={(next) => edit({ body: withRich(form.body, next) }, 'other')}
            className="text-sm leading-6"
            placeholder={t(M['notification_editor.body'])}
          />
        </div>
        <label className="flex items-center justify-between gap-3 text-[13px] font-medium text-foreground">
          {t(M['notification_editor.answers_table'])}
          <Switch
            checked={hasAnswersTable(form.body)}
            onCheckedChange={(on) => edit({ body: withAnswersTable(form.body, on) }, 'other')}
            aria-label={t(M['notification_editor.answers_table'])}
          />
        </label>
        <p className="text-[12px] text-muted-foreground">{t(M['notification_editor.answers_table_hint'])}</p>
      </div>

      {warnings.length > 0 ? (
        <Alert variant="warning" icon>
          <AlertDescription>
            <span className="block font-medium">{t(M['notification_editor.warnings'])}</span>
            <ul className="list-disc pl-5">
              {warnings.map((w) => (
                <li key={`${w.code}:${w.blockId}`}>{w.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {invalid ? (
        <Alert variant="destructive" icon>
          <AlertDescription>
            {t(M['notification_editor.refused_fields'], { detail: invalid.fields.map((f) => `${f.path}: ${f.message}`).join('; ') || invalid.message })}
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive" icon>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <p role="status" className="text-[13px] text-muted-foreground">
          {notice}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!canSave}>
          {t(M['notification_editor.save'])}
        </Button>
      </div>
    </form>
  );
}
