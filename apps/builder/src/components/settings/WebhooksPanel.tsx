import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { defineMessages, type MessageId } from '@form/i18n';
import { Alert, AlertDescription, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, TextLink } from '@dmacq/ui';
import { BUILDER_LOCALE, t } from '@/i18n';
import { ApiProblem, useActiveOrg } from '@/auth/client';
import { WebhookDeliveriesPanel, MissingPermission } from '@/components/settings/WebhookDeliveriesPanel';
import { WebhookEditor } from '@/components/settings/WebhookEditor';
import { WebhookSecretDialog, type IssuedSecretNotice } from '@/components/settings/WebhookSecretDialog';
import { factsOf, type FormFacts } from '@/components/settings/webhookForm';
import { EVENT_LABELS, W, WEBHOOK_SIGNATURE_DOC_URL, describeWebhookFailure, isForbidden } from '@/components/settings/webhookText';
import type { SettingsPanelProps } from '@/components/settings/types';
import { flushAutosave } from '@/persistence/autosave';
import { getRemoteDraft } from '@/persistence/draftsApi';
import { ALL_IN_PURPOSES, deleteWebhook, listWebhooks, rotateWebhookSecret, type CreatedWebhook, type Webhook } from '@/persistence/webhooksApi';

const M = defineMessages('builder', {
  'webhooks.title': 'Webhooks',
  'webhooks.intro': 'Send each response to a web address of yours as soon as it is stored. Every request is signed, so your receiver can check it came from fORM-.',
  'webhooks.add': 'Add webhook',
  'webhooks.loading': 'Loading webhooks…',
  'webhooks.sign_in': 'Sign in to manage this form’s webhooks.',
  'webhooks.not_saved': 'This form is not on the server yet, so webhooks cannot be set up. It saves by itself a moment after you edit it.',
  'webhooks.unreachable': 'The server cannot be reached. Check your connection and try again.',
  'webhooks.retry': 'Try again',
  'webhooks.none': 'No webhooks yet. Add one to send each response to your own system.',
  'webhooks.list': 'Webhooks of this form',
  'webhooks.on': 'On',
  'webhooks.off': 'Off',
  'webhooks.off_reason': 'Switched off: {reason}',
  'webhooks.off_fix': 'Fix the receiver, then change this webhook and turn it on again.',
  'webhooks.sends_when': 'Sent when',
  'webhooks.purposes': 'Purposes',
  'webhooks.fields': 'Fields',
  'webhooks.fields_all': 'Every field covered by the purposes',
  'webhooks.fields_picked': '{count, plural, one {# picked field} other {# picked fields}}',
  'webhooks.secret': 'Signing secret',
  'webhooks.secret_hint': 'Ends in {hint}',
  'webhooks.secret_rotated': 'replaced {date}',
  'webhooks.edit': 'Edit',
  'webhooks.edit_label': 'Edit the webhook at {host}',
  'webhooks.log': 'Delivery log',
  'webhooks.log_label': 'Delivery log of the webhook at {host}',
  'webhooks.rotate': 'Replace secret',
  'webhooks.rotate_label': 'Replace the signing secret of the webhook at {host}',
  'webhooks.delete': 'Delete',
  'webhooks.delete_label': 'Delete the webhook at {host}',
  'webhooks.saved': 'Webhook saved.',
  'webhooks.deleted': 'Webhook deleted.',
  'webhooks.rotate_title': 'Replace the signing secret?',
  'webhooks.rotate_body': 'The current secret stops working at once, including for deliveries still waiting to be sent. You get the new one to put in your receiver.',
  'webhooks.rotate_confirm': 'Replace secret',
  'webhooks.rotate_failed': 'The signing secret could not be replaced. Try again.',
  'webhooks.delete_title': 'Delete this webhook?',
  'webhooks.delete_body': 'Responses stop being sent to {host}. Its signing secret and its delivery log are deleted with it.',
  'webhooks.delete_confirm': 'Delete webhook',
  'webhooks.delete_failed': 'The webhook could not be deleted. Try again.',
  'webhooks.cancel': 'Cancel',
});

const date = new Intl.DateTimeFormat(BUILDER_LOCALE, { dateStyle: 'medium' });

type Blocked = 'sign_in' | 'forbidden' | 'not_saved' | 'unreachable';
type Load =
  | { status: 'loading' }
  | { status: 'blocked'; reason: Blocked }
  /** `facts` is null when the form's draft could not be read: the editor then has no purposes to offer. */
  | { status: 'ready'; items: Webhook[]; facts: FormFacts | null };

const BLOCKED_TEXT: Readonly<Record<Exclude<Blocked, 'forbidden'>, MessageId>> = {
  sign_in: M['webhooks.sign_in'],
  not_saved: M['webhooks.not_saved'],
  unreachable: M['webhooks.unreachable'],
};

function blockedBy(err: unknown): Blocked {
  if (isForbidden(err)) return 'forbidden';
  if (err instanceof ApiProblem && err.status === 404) return 'not_saved';
  if (err instanceof ApiProblem && err.status === 401) return 'sign_in';
  return 'unreachable';
}

/** The host of an address, which is enough to tell webhooks apart in a sentence; the path and query may carry a token. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type Editing = { kind: 'new' } | { kind: 'edit'; id: string } | null;
type Confirm = { kind: 'rotate' | 'delete'; webhook: Webhook } | null;

/**
 * The "Webhooks" tab of a form's settings (WP-1.18): the form's webhooks, an editor for one, the one-time signing secret
 * after a webhook is made or its secret replaced, and each webhook's delivery log. Sending answers to an outside address is
 * a disclosure, so the API needs `data.route` for every call; a role without it sees what it needs to ask for, not a broken
 * page. The signing secret is held in one piece of state, only while its dialog is open.
 */
export function WebhooksPanel({ formId }: SettingsPanelProps) {
  const org = useActiveOrg()?.id ?? null;
  // Another form or another org is another tab: its state starts over instead of showing the last one's.
  return <WebhooksSection key={`${org ?? ''}:${formId}`} org={org} formId={formId} />;
}

function WebhooksSection({ org, formId }: { org: string | null; formId: string }) {
  const [state, setLoad] = useState<Load>({ status: 'loading' });
  const [editing, setEditing] = useState<Editing>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The signing secret just issued, while its dialog is open. The only place it is held; closing the dialog clears it. */
  const [issued, setIssued] = useState<IssuedSecretNotice | null>(null);
  const [attempt, setAttempt] = useState(0);
  const load: Load = org === null ? { status: 'blocked', reason: 'sign_in' } : state;

  useEffect(() => {
    if (org === null) return;
    let live = true;
    void (async () => {
      // A form made a moment ago may not be on the server yet: send what is pending before asking about it.
      await flushAutosave().catch(() => undefined);
      try {
        // The form's draft says which purposes and fields there are to choose; not being able to read it leaves the list readable.
        const [items, draft] = await Promise.all([listWebhooks(org, formId), getRemoteDraft(org, formId).catch(() => null)]);
        if (live) setLoad({ status: 'ready', items, facts: draft ? factsOf(draft.draft) : null });
      } catch (err) {
        if (live) setLoad({ status: 'blocked', reason: blockedBy(err) });
      }
    })();
    return () => {
      live = false;
    };
  }, [org, formId, attempt]);

  const forbidden = () => setLoad({ status: 'blocked', reason: 'forbidden' });
  const reload = () => {
    setEditing(null);
    setLoad({ status: 'loading' });
    setAttempt((n) => n + 1);
  };
  const items = load.status === 'ready' ? load.items : [];
  const change = (fn: (current: Webhook[]) => Webhook[]) => setLoad((current) => (current.status === 'ready' ? { ...current, items: fn(current.items) } : current));

  function created({ webhook, secret }: CreatedWebhook) {
    change((current) => [...current, webhook]);
    setEditing(null);
    setError(null);
    setNotice(null);
    setIssued({ secret, kind: 'created', host: hostOf(webhook.url) });
  }

  function saved(webhook: Webhook) {
    change((current) => current.map((w) => (w.id === webhook.id ? webhook : w)));
    setEditing(null);
    setError(null);
    setNotice(t(M['webhooks.saved']));
  }

  async function confirmed() {
    if (org === null || confirm === null || busy) return;
    const { kind, webhook } = confirm;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (kind === 'delete') {
        await deleteWebhook(org, formId, webhook.id);
        change((current) => current.filter((w) => w.id !== webhook.id));
        setLogFor((open) => (open === webhook.id ? null : open));
        setEditing((open) => (open?.kind === 'edit' && open.id === webhook.id ? null : open));
        setNotice(t(M['webhooks.deleted']));
      } else {
        const next = await rotateWebhookSecret(org, formId, webhook.id);
        change((current) => current.map((w) => (w.id === webhook.id ? { ...w, secretHint: next.secretHint, secretRotatedAt: next.secretRotatedAt } : w)));
        setIssued({ secret: next.secret, kind: 'rotated', host: hostOf(webhook.url) });
      }
      setConfirm(null);
    } catch (err) {
      setConfirm(null);
      if (isForbidden(err)) forbidden();
      else setError(describeWebhookFailure(err, kind === 'delete' ? M['webhooks.delete_failed'] : M['webhooks.rotate_failed']));
    } finally {
      setBusy(false);
    }
  }

  const facts = load.status === 'ready' ? load.facts : null;
  const adding = editing?.kind === 'new';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-[640px]">
          <h2 className="text-[18px] font-semibold">{t(M['webhooks.title'])}</h2>
          <p className="mt-2 text-[15px] leading-6 text-muted-foreground">
            {t(M['webhooks.intro'])}{' '}
            <TextLink href={WEBHOOK_SIGNATURE_DOC_URL} target="_blank" rel="noopener noreferrer">
              {t(W['webhooks.signature_doc'])}
            </TextLink>
          </p>
        </div>
        {load.status === 'ready' && !adding ? (
          <Button type="button" onClick={() => setEditing({ kind: 'new' })}>
            <Plus />
            {t(M['webhooks.add'])}
          </Button>
        ) : null}
      </div>

      {load.status === 'loading' ? <p className="text-[14px] text-muted-foreground">{t(M['webhooks.loading'])}</p> : null}

      {load.status === 'blocked' && load.reason === 'forbidden' ? <MissingPermission /> : null}
      {load.status === 'blocked' && load.reason !== 'forbidden' ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-[14px] text-muted-foreground">{t(BLOCKED_TEXT[load.reason])}</p>
          {load.reason === 'unreachable' ? (
            <Button type="button" size="sm" variant="secondary" onClick={reload}>
              {t(M['webhooks.retry'])}
            </Button>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <Alert variant="success" icon>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive" icon>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {load.status === 'ready' && org !== null ? (
        <>
          {adding ? (
            <WebhookEditor org={org} formId={formId} webhook={null} facts={facts} onCreated={created} onSaved={saved} onCancel={() => setEditing(null)} onForbidden={forbidden} onReload={reload} />
          ) : null}

          {items.length === 0 && !adding ? <p className="text-[14px] text-muted-foreground">{t(M['webhooks.none'])}</p> : null}

          {items.length > 0 ? (
            <ul aria-label={t(M['webhooks.list'])} className="flex flex-col gap-4">
              {items.map((webhook) =>
                editing?.kind === 'edit' && editing.id === webhook.id ? (
                  <li key={webhook.id}>
                    <WebhookEditor
                      org={org}
                      formId={formId}
                      webhook={webhook}
                      facts={facts}
                      onCreated={created}
                      onSaved={saved}
                      onCancel={() => setEditing(null)}
                      onForbidden={forbidden}
                      onReload={reload}
                    />
                  </li>
                ) : (
                  <WebhookCard
                    key={webhook.id}
                    formId={formId}
                    webhook={webhook}
                    facts={facts}
                    logOpen={logFor === webhook.id}
                    onEdit={() => {
                      setNotice(null);
                      setEditing({ kind: 'edit', id: webhook.id });
                    }}
                    onToggleLog={() => setLogFor((open) => (open === webhook.id ? null : webhook.id))}
                    onRotate={() => setConfirm({ kind: 'rotate', webhook })}
                    onDelete={() => setConfirm({ kind: 'delete', webhook })}
                  />
                ),
              )}
            </ul>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog confirm={confirm} busy={busy} onConfirm={() => void confirmed()} onCancel={() => setConfirm(null)} />
      <WebhookSecretDialog issued={issued} onClose={() => setIssued(null)} />
    </div>
  );
}

function WebhookCard({
  formId,
  webhook,
  facts,
  logOpen,
  onEdit,
  onToggleLog,
  onRotate,
  onDelete,
}: {
  formId: string;
  webhook: Webhook;
  facts: FormFacts | null;
  logOpen: boolean;
  onEdit: () => void;
  onToggleLog: () => void;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const host = hostOf(webhook.url);
  const purposeNames = webhook.purposeIds.map((id) => facts?.purposes.find((p) => p.id === id)?.name ?? id);
  return (
    <li className="rounded-lg border border-border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-all text-[14px] font-medium">{webhook.url}</p>
          <div className="mt-1.5">
            <Badge variant={webhook.enabled ? 'success' : 'secondary'}>{t(webhook.enabled ? M['webhooks.on'] : M['webhooks.off'])}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" aria-label={t(M['webhooks.edit_label'], { host })} onClick={onEdit}>
            {t(M['webhooks.edit'])}
          </Button>
          <Button type="button" size="sm" variant="outline" aria-expanded={logOpen} aria-label={t(M['webhooks.log_label'], { host })} onClick={onToggleLog}>
            {t(M['webhooks.log'])}
          </Button>
          <Button type="button" size="sm" variant="outline" aria-label={t(M['webhooks.rotate_label'], { host })} onClick={onRotate}>
            {t(M['webhooks.rotate'])}
          </Button>
          <Button type="button" size="sm" variant="ghost" aria-label={t(M['webhooks.delete_label'], { host })} onClick={onDelete}>
            {t(M['webhooks.delete'])}
          </Button>
        </div>
      </div>

      {!webhook.enabled && webhook.disabledReason ? (
        <Alert variant="warning" icon className="mt-3">
          <AlertDescription>
            <span className="block">{t(M['webhooks.off_reason'], { reason: webhook.disabledReason })}</span>
            <span className="block">{t(M['webhooks.off_fix'])}</span>
          </AlertDescription>
        </Alert>
      ) : null}

      <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">{t(M['webhooks.sends_when'])}</dt>
        <dd>{webhook.events.map((event) => t(EVENT_LABELS[event])).join(', ')}</dd>
        <dt className="text-muted-foreground">{t(M['webhooks.purposes'])}</dt>
        <dd>{purposeNames.join(', ')}</dd>
        <dt className="text-muted-foreground">{t(M['webhooks.fields'])}</dt>
        <dd>{webhook.fieldKeys === ALL_IN_PURPOSES ? t(M['webhooks.fields_all']) : t(M['webhooks.fields_picked'], { count: webhook.fieldKeys.length })}</dd>
        <dt className="text-muted-foreground">{t(M['webhooks.secret'])}</dt>
        <dd>
          {t(M['webhooks.secret_hint'], { hint: webhook.secretHint })}
          {webhook.secretRotatedAt ? ` (${t(M['webhooks.secret_rotated'], { date: date.format(new Date(webhook.secretRotatedAt)) })})` : ''}
        </dd>
      </dl>

      {logOpen ? (
        <div className="mt-4 border-t border-border pt-4">
          <WebhookDeliveriesPanel formId={formId} webhookId={webhook.id} enabled={webhook.enabled} />
        </div>
      ) : null}
    </li>
  );
}

function ConfirmDialog({ confirm, busy, onConfirm, onCancel }: { confirm: Confirm; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  if (!confirm) return null;
  const rotate = confirm.kind === 'rotate';
  const host = hostOf(confirm.webhook.url);
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent dismissible={!busy}>
        <DialogHeader>
          <DialogTitle>{t(rotate ? M['webhooks.rotate_title'] : M['webhooks.delete_title'])}</DialogTitle>
          <DialogDescription>{rotate ? t(M['webhooks.rotate_body']) : t(M['webhooks.delete_body'], { host })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            {t(M['webhooks.cancel'])}
          </Button>
          <Button type="button" variant={rotate ? 'default' : 'destructive'} disabled={busy} onClick={onConfirm}>
            {t(rotate ? M['webhooks.rotate_confirm'] : M['webhooks.delete_confirm'])}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
