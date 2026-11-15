import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Alert,
  AlertDescription,
  Badge,
  Button,
} from '@dmacq/ui';
import { defineMessages, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import { ApiProblem, useActiveOrg } from '@/auth/client';
import { NotificationEditor } from '@/components/settings/NotificationEditor';
import { blankNotification, factsOf, formOf, type DraftFacts } from '@/components/settings/notificationsModel';
import type { SettingsPanelProps } from '@/components/settings/types';
import { problemText } from '@/pages/auth/util';
import { flushAutosave } from '@/persistence/autosave';
import { getRemoteDraft } from '@/persistence/draftsApi';
import { listEmailSenders, type EmailSender } from '@/persistence/emailSendersApi';
import {
  deleteNotification,
  listNotifications,
  listOrgMembers,
  type Notification,
  type NotificationForm,
  type OrgMember,
} from '@/persistence/notificationsApi';

const M = defineMessages('builder', {
  'settings_notifications.title': 'Email notifications',
  'settings_notifications.intro': 'The emails sent when someone submits this form: one to your team, and a reply to the respondent. Each one names the purposes whose answers it may carry.',
  'settings_notifications.loading': 'Loading emails…',
  'settings_notifications.sign_in': 'Sign in to set up this form’s emails.',
  'settings_notifications.not_saved': 'This form is not on the server yet, so its emails cannot be set up. It saves by itself a moment after you edit it.',
  'settings_notifications.forbidden': 'You do not have permission to see this form’s emails.',
  'settings_notifications.unreachable': 'The server cannot be reached. Check your connection and try again.',
  'settings_notifications.retry': 'Try again',
  'settings_notifications.none': 'No emails yet. Add one to tell your team when a response arrives, or to thank the respondent.',
  'settings_notifications.add_owner': 'Add an email to your team',
  'settings_notifications.add_autoresponder': 'Add a reply to the respondent',
  'settings_notifications.kind_owner': 'To your team',
  'settings_notifications.kind_autoresponder': 'To the respondent',
  'settings_notifications.on': 'On',
  'settings_notifications.off': 'Off',
  'settings_notifications.attention': 'Needs attention',
  'settings_notifications.untitled': 'Untitled email',
  'settings_notifications.edit': 'Edit {name}',
  'settings_notifications.edit_button': 'Edit',
  'settings_notifications.delete': 'Delete {name}',
  'settings_notifications.delete_button': 'Delete',
  'settings_notifications.delete_title': 'Delete “{name}”?',
  'settings_notifications.delete_text': 'It stops sending for new responses. Emails already waiting to be sent still go out, and the email log keeps its entries.',
  'settings_notifications.delete_cancel': 'Keep it',
  'settings_notifications.delete_confirm': 'Delete email',
  'settings_notifications.deleted': 'Email deleted.',
});

type Blocked = 'sign_in' | 'not_saved' | 'forbidden' | 'unreachable';

interface Ready {
  items: Notification[];
  senders: EmailSender[];
  /** Null when this member may not list the org's members: the recipient picker then offers addresses and groups only. */
  members: OrgMember[] | null;
  facts: DraftFacts;
}

type Load = { status: 'loading' } | { status: 'blocked'; reason: Blocked } | ({ status: 'ready' } & Ready);

const BLOCKED_TEXT: Readonly<Record<Blocked, MessageId>> = {
  sign_in: M['settings_notifications.sign_in'],
  not_saved: M['settings_notifications.not_saved'],
  forbidden: M['settings_notifications.forbidden'],
  unreachable: M['settings_notifications.unreachable'],
};

/** Why the emails could not be read: the form is not on the server yet (404), the caller may not (401, 403), or the server did not answer. */
function blockedBy(err: unknown): Blocked {
  if (err instanceof ApiProblem) {
    if (err.status === 404) return 'not_saved';
    if (err.status === 401) return 'sign_in';
    if (err.status === 403) return 'forbidden';
  }
  return 'unreachable';
}

/** The editor that is open: a saved email (`id`) or a new one (`id` null); `initial` is what it starts as. `key` makes a fresh editor of the same email start over. */
interface Editing {
  key: string;
  id: string | null;
  initial: NotificationForm;
}

let opened = 0;
const nextKey = (): string => `edit-${(opened += 1)}`;

/**
 * The "Emails" tab of a form's settings: its notifications and autoresponders (WP-1.16). It lists them, and opens one in an
 * editor to change its type, sender, recipients, purposes, subject and message, or to add and delete one. What a save is
 * checked against (the form's purposes and fields) is the form's saved draft on the server, not what this browser holds, so
 * the page sends any pending change first. The panel only shows what the API holds; every rule is the API's.
 */
export function NotificationsPanel({ formId }: SettingsPanelProps) {
  const org = useActiveOrg()?.id ?? null;
  // Another form or another org starts over instead of showing the last one's emails.
  return <Section key={`${org ?? ''}:${formId}`} org={org} formId={formId} />;
}

function Section({ org, formId }: { org: string | null; formId: string }) {
  const [state, setLoad] = useState<Load>({ status: 'loading' });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [asking, setAsking] = useState<Notification | null>(null);
  const [attempt, setAttempt] = useState(0);
  const load: Load = org === null ? { status: 'blocked', reason: 'sign_in' } : state;

  const fetchAll = useCallback(async (): Promise<Ready> => {
    const owner = org ?? '';
    const [items, senders, members, draft] = await Promise.all([
      listNotifications(owner, formId),
      listEmailSenders(owner),
      // The members only fill the recipient picker: a list that cannot be read leaves addresses and groups, and nothing else.
      listOrgMembers(owner).catch(() => null),
      getRemoteDraft(owner, formId),
    ]);
    return { items, senders, members, facts: factsOf(draft?.draft ?? null) };
  }, [org, formId]);

  useEffect(() => {
    if (org === null) return;
    let live = true;
    void (async () => {
      // A change made a moment ago in the builder may not be on the server yet, and the server checks against its copy.
      await flushAutosave().catch(() => undefined);
      try {
        const all = await fetchAll();
        if (live) setLoad({ status: 'ready', ...all });
      } catch (err) {
        if (live) setLoad({ status: 'blocked', reason: blockedBy(err) });
      }
    })();
    return () => {
      live = false;
    };
  }, [org, attempt, fetchAll]);

  const ready = load.status === 'ready' ? load : null;

  const onSaved = (saved: Notification) =>
    setLoad((l) => {
      if (l.status !== 'ready') return l;
      const exists = l.items.some((n) => n.id === saved.id);
      return { ...l, items: exists ? l.items.map((n) => (n.id === saved.id ? saved : n)) : [...l.items, saved] };
    });

  /** Reads everything again (after a conflict) and opens the email afresh: the server's version is the one to edit. */
  const reload = async (id: string | null) => {
    try {
      const all = await fetchAll();
      setLoad({ status: 'ready', ...all });
      const found = id ? all.items.find((n) => n.id === id) : undefined;
      setEditing(found ? { key: nextKey(), id: found.id, initial: formOf(found.config) } : null);
      setNotice(null);
    } catch (err) {
      setError(problemText(err));
    }
  };

  const remove = async (target: Notification) => {
    setAsking(null);
    setError(null);
    try {
      await deleteNotification(org ?? '', formId, target.id);
      setLoad((l) => (l.status === 'ready' ? { ...l, items: l.items.filter((n) => n.id !== target.id) } : l));
      setEditing((e) => (e?.id === target.id ? null : e));
      setNotice(t(M['settings_notifications.deleted']));
    } catch (err) {
      setError(problemText(err));
    }
  };

  const open = (kind: NotificationForm['kind']) => {
    if (!ready) return;
    setNotice(null);
    setError(null);
    setEditing({ key: nextKey(), id: null, initial: blankNotification(kind, ready.facts) });
  };

  const editedItem = ready && editing?.id ? (ready.items.find((n) => n.id === editing.id) ?? null) : null;

  return (
    <div>
      <h2 className="text-[18px] font-semibold">{t(M['settings_notifications.title'])}</h2>
      <p className="mt-2 text-[15px] leading-6 text-muted-foreground">{t(M['settings_notifications.intro'])}</p>

      {load.status === 'loading' ? <p className="mt-4 text-[14px] text-muted-foreground">{t(M['settings_notifications.loading'])}</p> : null}
      {load.status === 'blocked' ? (
        <div className="mt-4 space-y-2">
          <Alert variant="warning" icon>
            <AlertDescription>{t(BLOCKED_TEXT[load.reason])}</AlertDescription>
          </Alert>
          {load.reason === 'unreachable' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setLoad({ status: 'loading' });
                setAttempt((n) => n + 1);
              }}
            >
              {t(M['settings_notifications.retry'])}
            </Button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <Alert variant="destructive" icon className="mt-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice && !editing ? (
        <p role="status" className="mt-4 text-[13px] text-muted-foreground">
          {notice}
        </p>
      ) : null}

      {ready && editing ? (
        <div className="mt-6">
          <NotificationEditor
            key={editing.key}
            org={org ?? ''}
            formId={formId}
            notification={editedItem}
            initial={editing.initial}
            senders={ready.senders}
            members={ready.members}
            facts={ready.facts}
            onSaved={onSaved}
            onReload={(id) => void reload(id)}
            onClose={() => setEditing(null)}
          />
        </div>
      ) : null}

      {ready && !editing ? (
        <div className="mt-6 space-y-4">
          {ready.items.length === 0 ? (
            <p className="text-[14px] text-muted-foreground">{t(M['settings_notifications.none'])}</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {ready.items.map((n) => {
                const name = n.config.name.trim() || t(M['settings_notifications.untitled']);
                return (
                  <li key={n.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[14px]">
                    <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                    <span className="text-[13px] text-muted-foreground">{t(n.config.kind === 'owner' ? M['settings_notifications.kind_owner'] : M['settings_notifications.kind_autoresponder'])}</span>
                    <Badge variant={n.config.enabled ? 'success' : 'secondary'} size="sm">
                      {t(n.config.enabled ? M['settings_notifications.on'] : M['settings_notifications.off'])}
                    </Badge>
                    {n.warnings.length > 0 ? (
                      <Badge variant="warning" size="sm">
                        {t(M['settings_notifications.attention'])}
                      </Badge>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={t(M['settings_notifications.edit'], { name })}
                      onClick={() => {
                        setNotice(null);
                        setError(null);
                        setEditing({ key: nextKey(), id: n.id, initial: formOf(n.config) });
                      }}
                    >
                      {t(M['settings_notifications.edit_button'])}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" aria-label={t(M['settings_notifications.delete'], { name })} onClick={() => setAsking(n)}>
                      {t(M['settings_notifications.delete_button'])}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => open('owner')}>
              {t(M['settings_notifications.add_owner'])}
            </Button>
            <Button type="button" variant="outline" onClick={() => open('autoresponder')}>
              {t(M['settings_notifications.add_autoresponder'])}
            </Button>
          </div>
        </div>
      ) : null}

      <AlertDialog open={asking !== null} onOpenChange={(o) => !o && setAsking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(M['settings_notifications.delete_title'], { name: asking?.config.name.trim() || t(M['settings_notifications.untitled']) })}</AlertDialogTitle>
            <AlertDialogDescription>{t(M['settings_notifications.delete_text'])}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(M['settings_notifications.delete_cancel'])}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => asking && void remove(asking)}>
              {t(M['settings_notifications.delete_confirm'])}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
