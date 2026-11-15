import { useCallback, useEffect, useState } from 'react';
import { defineMessages, type MessageId } from '@form/i18n';
import { Alert, AlertDescription, Badge, Button } from '@dmacq/ui';
import { t } from '@/i18n';
import { ApiProblem, useActiveOrg } from '@/auth/client';
import { NiceSelect } from '@/components/NiceSelect';
import { formatWhen } from '@/components/responses/format';
import type { SettingsPanelProps } from '@/components/settings/types';
import { problemText } from '@/pages/auth/util';
import { MESSAGE_STATUSES, listEmailLog, listNotifications, type EmailLogItem, type MessageStatus } from '@/persistence/notificationsApi';

const M = defineMessages('builder', {
  'settings_email_log.title': 'Email log',
  'settings_email_log.intro': 'The emails this form has sent, newest first, and whether they arrived. Addresses are masked, and no message text is kept.',
  'settings_email_log.loading': 'Loading the log…',
  'settings_email_log.empty': 'No emails yet. They appear here once someone submits the form.',
  'settings_email_log.empty_filtered': 'No emails with that status.',
  'settings_email_log.sign_in': 'Sign in to see this form’s email log.',
  'settings_email_log.not_saved': 'This form is not on the server yet, so it has sent no emails.',
  'settings_email_log.forbidden': 'The email log says who a response’s data was emailed to, so it needs permission to read responses. Ask an owner or admin.',
  'settings_email_log.unreachable': 'The server cannot be reached. Check your connection and try again.',
  'settings_email_log.retry': 'Try again',
  'settings_email_log.filter': 'Show emails that are',
  'settings_email_log.filter_all': 'Any status',
  'settings_email_log.caption': 'Emails sent for this form',
  'settings_email_log.col_when': 'Queued',
  'settings_email_log.col_email': 'Email',
  'settings_email_log.col_to': 'To',
  'settings_email_log.col_status': 'Status',
  'settings_email_log.col_attempts': 'Attempts',
  'settings_email_log.col_detail': 'Detail',
  'settings_email_log.status.queued': 'Queued',
  'settings_email_log.status.sending': 'Sending',
  'settings_email_log.status.retrying': 'Retrying',
  'settings_email_log.status.sent': 'Sent',
  'settings_email_log.status.failed': 'Failed',
  'settings_email_log.role.to': 'to',
  'settings_email_log.role.cc': 'cc',
  'settings_email_log.role.bcc': 'bcc',
  'settings_email_log.deleted_email': 'A deleted email',
  'settings_email_log.sent_at': 'Sent {when}',
  'settings_email_log.more': 'Show older emails',
  'settings_email_log.more_loading': 'Loading…',
});

const STATUS_TEXT: Record<MessageStatus, MessageId> = {
  queued: M['settings_email_log.status.queued'],
  sending: M['settings_email_log.status.sending'],
  retrying: M['settings_email_log.status.retrying'],
  sent: M['settings_email_log.status.sent'],
  failed: M['settings_email_log.status.failed'],
};

const STATUS_BADGE: Record<MessageStatus, 'success' | 'warning' | 'danger' | 'secondary'> = {
  queued: 'secondary',
  sending: 'secondary',
  retrying: 'warning',
  sent: 'success',
  failed: 'danger',
};

const ROLE_TEXT: Record<string, MessageId> = {
  to: M['settings_email_log.role.to'],
  cc: M['settings_email_log.role.cc'],
  bcc: M['settings_email_log.role.bcc'],
};

const PAGE = 50;
const ALL = '__all__';

type Blocked = 'sign_in' | 'not_saved' | 'forbidden' | 'unreachable';
const BLOCKED_TEXT: Readonly<Record<Blocked, MessageId>> = {
  sign_in: M['settings_email_log.sign_in'],
  not_saved: M['settings_email_log.not_saved'],
  forbidden: M['settings_email_log.forbidden'],
  unreachable: M['settings_email_log.unreachable'],
};

function blockedBy(err: unknown): Blocked {
  if (err instanceof ApiProblem) {
    if (err.status === 404) return 'not_saved';
    if (err.status === 401) return 'sign_in';
    if (err.status === 403) return 'forbidden';
  }
  return 'unreachable';
}

/**
 * The "Email log" tab of a form's settings (WP-1.16): the emails the worker made for its responses and how each delivery
 * went, newest first, a page at a time (the API pages by a signed cursor, passed back as it came). Recipients are masked as
 * the worker stored them. Reading needs `submissions.read`, so a member without it sees why the log is closed to them.
 */
export function EmailLogPanel({ formId }: SettingsPanelProps) {
  const org = useActiveOrg()?.id ?? null;
  return <Log key={`${org ?? ''}:${formId}`} org={org} formId={formId} />;
}

function Log({ org, formId }: { org: string | null; formId: string }) {
  const [status, setStatus] = useState<MessageStatus | null>(null);
  const [items, setItems] = useState<EmailLogItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [blocked, setBlocked] = useState<Blocked | null>(org === null ? 'sign_in' : null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);

  /** Back to a first page that has not arrived yet: the filter changed, or the last try found no server. */
  const restart = () => {
    setItems(null);
    setBlocked(null);
    setError(null);
  };

  // The first page, again whenever the filter changes or a retry is asked for.
  useEffect(() => {
    if (org === null) return;
    let live = true;
    listEmailLog(org, formId, { limit: PAGE, status: status ?? undefined }).then(
      (page) => {
        if (!live) return;
        setItems(page.items);
        setNext(page.nextCursor);
      },
      (err: unknown) => live && setBlocked(blockedBy(err)),
    );
    return () => {
      live = false;
    };
  }, [org, formId, status, attempt]);

  // The names of the emails, to say which one each line is about. Best effort: without them a line shows only what it has.
  useEffect(() => {
    if (org === null) return;
    let live = true;
    listNotifications(org, formId).then(
      (all) => live && setNames(new Map(all.map((n) => [n.id, n.config.name]))),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [org, formId]);

  const more = useCallback(async () => {
    if (org === null || next === null) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await listEmailLog(org, formId, { limit: PAGE, status: status ?? undefined, cursor: next });
      setItems((all) => [...(all ?? []), ...page.items]);
      setNext(page.nextCursor);
    } catch (err) {
      setError(problemText(err));
    } finally {
      setLoadingMore(false);
    }
  }, [org, formId, status, next]);

  return (
    <div>
      <h2 className="text-[18px] font-semibold">{t(M['settings_email_log.title'])}</h2>
      <p className="mt-2 text-[15px] leading-6 text-muted-foreground">{t(M['settings_email_log.intro'])}</p>

      {blocked ? (
        <div className="mt-4 space-y-2">
          <Alert variant="warning" icon>
            <AlertDescription>{t(BLOCKED_TEXT[blocked])}</AlertDescription>
          </Alert>
          {blocked === 'unreachable' ? (
            <Button type="button" variant="outline" size="sm" onClick={() => {
                restart();
                setAttempt((n) => n + 1);
              }}
            >
              {t(M['settings_email_log.retry'])}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-2">
            <span className="text-[13px] text-muted-foreground">{t(M['settings_email_log.filter'])}</span>
            <div className="w-[180px]">
              <NiceSelect
                size="sm"
                aria-label={t(M['settings_email_log.filter'])}
                value={status ?? ALL}
                onChange={(v) => {
                  restart();
                  setStatus(MESSAGE_STATUSES.find((s) => s === v) ?? null);
                }}
                options={[{ value: ALL, label: t(M['settings_email_log.filter_all']) }, ...MESSAGE_STATUSES.map((s) => ({ value: s, label: t(STATUS_TEXT[s]) }))]}
              />
            </div>
          </div>

          {items === null ? <p className="mt-4 text-[14px] text-muted-foreground">{t(M['settings_email_log.loading'])}</p> : null}
          {items !== null && items.length === 0 ? (
            <p className="mt-4 text-[14px] text-muted-foreground">{t(status ? M['settings_email_log.empty_filtered'] : M['settings_email_log.empty'])}</p>
          ) : null}
          {items !== null && items.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <caption className="sr-only">{t(M['settings_email_log.caption'])}</caption>
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th scope="col" className="py-2 pr-3 font-medium">{t(M['settings_email_log.col_when'])}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">{t(M['settings_email_log.col_email'])}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">{t(M['settings_email_log.col_to'])}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">{t(M['settings_email_log.col_status'])}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">{t(M['settings_email_log.col_attempts'])}</th>
                    <th scope="col" className="py-2 font-medium">{t(M['settings_email_log.col_detail'])}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((m) => {
                    const role = ROLE_TEXT[m.role];
                    return (
                      <tr key={m.id} className="border-b border-border align-top">
                        <td className="whitespace-nowrap py-2 pr-3">{formatWhen(m.createdAt)}</td>
                        <td className="py-2 pr-3">{names.get(m.notificationId) ?? t(M['settings_email_log.deleted_email'])}</td>
                        <td className="py-2 pr-3">
                          {m.to.join(', ')}
                          {role ? <span className="ml-1 text-muted-foreground">({t(role)})</span> : null}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge variant={STATUS_BADGE[m.status]} size="sm">
                            {t(STATUS_TEXT[m.status])}
                          </Badge>
                        </td>
                        <td className="py-2 pr-3 tabular-nums">{m.attempts}</td>
                        <td className="py-2 text-muted-foreground">
                          {m.lastError ?? (m.sentAt ? t(M['settings_email_log.sent_at'], { when: formatWhen(m.sentAt) }) : '')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {error ? (
            <Alert variant="destructive" icon className="mt-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {next !== null ? (
            <Button type="button" variant="outline" size="sm" className="mt-4" disabled={loadingMore} onClick={() => void more()}>
              {t(loadingMore ? M['settings_email_log.more_loading'] : M['settings_email_log.more'])}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
