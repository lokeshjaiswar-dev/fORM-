import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Field,
  Input,
} from '@dmacq/ui';
import { defineMessages, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import { ApiProblem, useActiveOrg } from '@/auth/client';
import { formatWhen } from '@/components/responses/format';
import { problemText, submit } from '@/pages/auth/util';
import {
  addEmailSender,
  canManageSenders,
  changeEmailSender,
  deleteEmailSender,
  listEmailSenders,
  testEmailSender,
  type EmailSender,
  type SenderChange,
} from '@/persistence/emailSendersApi';

const M = defineMessages('builder', {
  'email_senders.title': 'Email senders',
  'email_senders.back': 'Back to organisation settings',
  'email_senders.intro': 'The addresses your organisation sends form emails from, each with the mail server it sends through. A form’s emails use one of these, or the platform’s own sender when none is chosen.',
  'email_senders.loading': 'Loading senders…',
  'email_senders.sign_in': 'Sign in to see your organisation’s email senders.',
  'email_senders.forbidden': 'You do not have permission to see the email senders.',
  'email_senders.unreachable': 'The server cannot be reached. Check your connection and try again.',
  'email_senders.retry': 'Try again',
  'email_senders.none': 'No senders yet. Forms send from the platform’s own address until you add one.',
  'email_senders.read_only': 'Only owners and admins can add, change, test or delete senders.',
  'email_senders.relay': 'Sends through {host}:{port} ({tls}){user}',
  'email_senders.relay_user': ', signed in as {name}',
  'email_senders.tls_on': 'encrypted',
  'email_senders.tls_off': 'starts plain, then upgrades if the server offers it',
  'email_senders.verified': 'Test message delivered {when}',
  'email_senders.unverified': 'Not tested yet',
  'email_senders.last_error': 'Last test failed: {error}',
  'email_senders.test': 'Test',
  'email_senders.test_sender': 'Send a test message through {name}',
  'email_senders.testing': 'Testing…',
  'email_senders.test_ok': 'The test message was delivered to your own address.',
  'email_senders.test_failed': 'The test message was not delivered: {error}',
  'email_senders.edit': 'Edit',
  'email_senders.edit_sender': 'Edit {name}',
  'email_senders.delete': 'Delete',
  'email_senders.delete_sender': 'Delete {name}',
  'email_senders.delete_title': 'Delete “{name}”?',
  'email_senders.delete_text': 'The mail server’s password is deleted with it. A form that still sends from this sender stops you: choose another sender for its emails first.',
  'email_senders.delete_cancel': 'Keep it',
  'email_senders.delete_confirm': 'Delete sender',
  'email_senders.form_add': 'Add a sender',
  'email_senders.form_change': 'Change {name}',
  'email_senders.name': 'Name',
  'email_senders.from_address': 'From address',
  'email_senders.from_name': 'From name (optional)',
  'email_senders.smtp_url': 'SMTP URL',
  'email_senders.smtp_url_new': 'New SMTP URL',
  'email_senders.smtp_url_hint': 'For example smtps://user:password@smtp.example.com:465. It holds the password, so it is stored sealed and never shown again.',
  'email_senders.smtp_url_keep': 'Leave this empty to keep the mail server the sender uses now. It is never shown again, so type the whole URL to change it.',
  'email_senders.save_add': 'Add sender',
  'email_senders.save_change': 'Save changes',
  'email_senders.cancel': 'Cancel',
  'email_senders.saved': 'Sender saved. Send a test message to check it works.',
  'email_senders.deleted': 'Sender deleted.',
});

type Blocked = 'sign_in' | 'forbidden' | 'unreachable';
const BLOCKED_TEXT: Readonly<Record<Blocked, MessageId>> = {
  sign_in: M['email_senders.sign_in'],
  forbidden: M['email_senders.forbidden'],
  unreachable: M['email_senders.unreachable'],
};

function blockedBy(err: unknown): Blocked {
  if (err instanceof ApiProblem) {
    if (err.status === 401) return 'sign_in';
    if (err.status === 403) return 'forbidden';
  }
  return 'unreachable';
}

/** What a test of one sender said: the message was delivered, it was not (with the server's scrubbed words), or the call itself failed. */
type Outcome = { ok: true } | { ok: false; text: string };

/**
 * `/org/email-senders`: the org's email senders, the "from" addresses of form notifications (WP-1.16). Anyone who edits a
 * form's emails can see the list; adding, changing, testing and deleting need `org.settings`, which the API checks again on
 * every call. The SMTP URL carries the mail server's password, so it is write-only: its box is always empty, and what is
 * shown about the relay is only its host, port, encryption and user name.
 */
export function EmailSendersPage() {
  const org = useActiveOrg()?.id ?? null;
  return (
    <main className="mx-auto w-full max-w-[720px] px-8 pb-24 pt-8 text-foreground">
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-3">
        <Link to="/org/settings">
          <ArrowLeft />
          {t(M['email_senders.back'])}
        </Link>
      </Button>
      <h1 className="text-[28px] font-bold leading-[1.15] tracking-[-0.02em]">{t(M['email_senders.title'])}</h1>
      <p className="mt-3 text-[15px] leading-6 text-muted-foreground">{t(M['email_senders.intro'])}</p>
      <Senders key={org ?? ''} org={org} />
    </main>
  );
}

function Senders({ org }: { org: string | null }) {
  const [senders, setSenders] = useState<EmailSender[] | null>(null);
  const [manage, setManage] = useState(false);
  const [blocked, setBlocked] = useState<Blocked | null>(org === null ? 'sign_in' : null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Record<string, Outcome | 'running'>>({});
  const [editing, setEditing] = useState<EmailSender | null>(null);
  const [asking, setAsking] = useState<EmailSender | null>(null);

  useEffect(() => {
    if (org === null) return;
    let live = true;
    Promise.all([listEmailSenders(org), canManageSenders(org)]).then(
      ([all, may]) => {
        if (!live) return;
        setSenders(all);
        setManage(may);
      },
      (err: unknown) => live && setBlocked(blockedBy(err)),
    );
    return () => {
      live = false;
    };
  }, [org, attempt]);

  const replace = useCallback((saved: EmailSender) => setSenders((all) => (all ?? []).map((s) => (s.id === saved.id ? saved : s))), []);

  async function test(sender: EmailSender) {
    if (org === null) return;
    setOutcome((o) => ({ ...o, [sender.id]: 'running' }));
    try {
      const result = await testEmailSender(org, sender.id);
      replace({ ...sender, verifiedAt: result.verifiedAt, lastTestError: result.error });
      setOutcome((o) => ({ ...o, [sender.id]: result.ok ? { ok: true } : { ok: false, text: result.error ?? '' } }));
    } catch (err) {
      setOutcome((o) => ({ ...o, [sender.id]: { ok: false, text: problemText(err) } }));
    }
  }

  async function remove(sender: EmailSender) {
    setAsking(null);
    if (org === null) return;
    setError(null);
    setNotice(null);
    try {
      await deleteEmailSender(org, sender.id);
      setSenders((all) => (all ?? []).filter((s) => s.id !== sender.id));
      setEditing((e) => (e?.id === sender.id ? null : e));
      setNotice(t(M['email_senders.deleted']));
    } catch (err) {
      setError(problemText(err));
    }
  }

  if (blocked) {
    return (
      <div className="mt-6 space-y-2">
        <Alert variant="warning" icon>
          <AlertDescription>{t(BLOCKED_TEXT[blocked])}</AlertDescription>
        </Alert>
        {blocked === 'unreachable' ? (
          <Button type="button" variant="outline" size="sm" onClick={() => {
              setBlocked(null);
              setAttempt((n) => n + 1);
            }}
          >
            {t(M['email_senders.retry'])}
          </Button>
        ) : null}
      </div>
    );
  }
  if (senders === null) return <p className="mt-6 text-[14px] text-muted-foreground">{t(M['email_senders.loading'])}</p>;

  return (
    <div className="mt-6">
      {error ? (
        <Alert variant="destructive" icon className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <p role="status" className="mb-4 text-[13px] text-muted-foreground">
          {notice}
        </p>
      ) : null}

      {senders.length === 0 ? (
        <p className="text-[14px] text-muted-foreground">{t(M['email_senders.none'])}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {senders.map((s) => {
            const result = outcome[s.id];
            return (
              <li key={s.id} className="space-y-1.5 px-3 py-3 text-[14px]">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                  <Badge variant={s.verifiedAt ? 'success' : 'secondary'} size="sm">
                    {s.verifiedAt ? t(M['email_senders.verified'], { when: formatWhen(s.verifiedAt) }) : t(M['email_senders.unverified'])}
                  </Badge>
                </div>
                <p className="text-[13px] text-muted-foreground">{s.fromName ? `${s.fromName} <${s.fromAddress}>` : s.fromAddress}</p>
                {s.smtp ? (
                  <p className="text-[13px] text-muted-foreground">
                    {t(M['email_senders.relay'], {
                      host: s.smtp.host,
                      port: s.smtp.port,
                      tls: t(s.smtp.secure ? M['email_senders.tls_on'] : M['email_senders.tls_off']),
                      user: s.smtp.username ? t(M['email_senders.relay_user'], { name: s.smtp.username }) : '',
                    })}
                  </p>
                ) : null}
                {s.lastTestError && !s.verifiedAt ? <p className="text-[13px] text-destructive">{t(M['email_senders.last_error'], { error: s.lastTestError })}</p> : null}
                {result === 'running' ? <p className="text-[13px] text-muted-foreground">{t(M['email_senders.testing'])}</p> : null}
                {result && result !== 'running' ? (
                  result.ok ? (
                    <p role="status" className="text-[13px] text-foreground">
                      {t(M['email_senders.test_ok'])}
                    </p>
                  ) : (
                    <p role="alert" className="text-[13px] text-destructive">
                      {t(M['email_senders.test_failed'], { error: result.text })}
                    </p>
                  )
                ) : null}
                {manage ? (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button type="button" size="sm" variant="outline" disabled={result === 'running'} aria-label={t(M['email_senders.test_sender'], { name: s.name })} onClick={() => void test(s)}>
                      {t(M['email_senders.test'])}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" aria-label={t(M['email_senders.edit_sender'], { name: s.name })} onClick={() => setEditing(s)}>
                      {t(M['email_senders.edit'])}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" aria-label={t(M['email_senders.delete_sender'], { name: s.name })} onClick={() => setAsking(s)}>
                      {t(M['email_senders.delete'])}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {manage && org !== null ? (
        <SenderForm
          key={editing?.id ?? 'new'}
          org={org}
          sender={editing}
          onDone={(saved) => {
            if (saved) {
              setSenders((all) => (all?.some((s) => s.id === saved.id) ? all.map((s) => (s.id === saved.id ? saved : s)) : [...(all ?? []), saved]));
              setNotice(t(M['email_senders.saved']));
              setError(null);
            }
            setEditing(null);
          }}
        />
      ) : (
        <p className="mt-4 text-[13px] text-muted-foreground">{t(M['email_senders.read_only'])}</p>
      )}

      <AlertDialog open={asking !== null} onOpenChange={(o) => !o && setAsking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(M['email_senders.delete_title'], { name: asking?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t(M['email_senders.delete_text'])}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(M['email_senders.delete_cancel'])}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => asking && void remove(asking)}>
              {t(M['email_senders.delete_confirm'])}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Adds a sender, or changes `sender`. The SMTP URL box is the one place a password is typed: it starts empty (also when
 * changing, where empty means "keep the relay it has") and is emptied again as soon as the save is accepted. It is a
 * password-type box, so the URL is not shown on screen or offered back by the browser.
 */
function SenderForm({ org, sender, onDone }: { org: string; sender: EmailSender | null; onDone: (saved: EmailSender | null) => void }) {
  const [name, setName] = useState(sender?.name ?? '');
  const [fromAddress, setFromAddress] = useState(sender?.fromAddress ?? '');
  const [fromName, setFromName] = useState(sender?.fromName ?? '');
  const [smtpUrl, setSmtpUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = name.trim() !== '' && fromAddress.trim() !== '' && (sender !== null || smtpUrl.trim() !== '');

  async function save() {
    setBusy(true);
    setError(null);
    try {
      let saved: EmailSender;
      if (sender) {
        const change: SenderChange = {};
        if (name.trim() !== sender.name) change.name = name.trim();
        if (fromAddress.trim() !== sender.fromAddress) change.fromAddress = fromAddress.trim();
        if (fromName.trim() !== (sender.fromName ?? '')) change.fromName = fromName.trim() === '' ? null : fromName.trim();
        if (smtpUrl.trim() !== '') change.smtpUrl = smtpUrl.trim();
        // Nothing changed: there is nothing to send, and the sender stays as it was.
        if (Object.keys(change).length === 0) return onDone(null);
        saved = await changeEmailSender(org, sender.id, change);
      } else {
        saved = await addEmailSender(org, { name: name.trim(), fromAddress: fromAddress.trim(), fromName: fromName.trim() || undefined, smtpUrl: smtpUrl.trim() });
      }
      // The URL is gone from this page the moment the server has it.
      setSmtpUrl('');
      if (!sender) {
        setName('');
        setFromAddress('');
        setFromName('');
      }
      onDone(saved);
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-8 space-y-3" aria-label={sender ? t(M['email_senders.form_change'], { name: sender.name }) : t(M['email_senders.form_add'])} onSubmit={submit(() => void save())}>
      <h2 className="text-[15px] font-semibold">{sender ? t(M['email_senders.form_change'], { name: sender.name }) : t(M['email_senders.form_add'])}</h2>
      <Field label={t(M['email_senders.name'])}>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" required />
      </Field>
      <Field label={t(M['email_senders.from_address'])}>
        <Input type="email" value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} maxLength={254} autoComplete="off" required />
      </Field>
      <Field label={t(M['email_senders.from_name'])}>
        <Input value={fromName} onChange={(e) => setFromName(e.target.value)} maxLength={120} autoComplete="off" />
      </Field>
      <Field label={sender ? t(M['email_senders.smtp_url_new']) : t(M['email_senders.smtp_url'])} hint={sender ? t(M['email_senders.smtp_url_keep']) : t(M['email_senders.smtp_url_hint'])}>
        <Input type="password" value={smtpUrl} onChange={(e) => setSmtpUrl(e.target.value)} maxLength={2048} autoComplete="off" spellCheck={false} placeholder="smtps://" />
      </Field>
      {error ? (
        <Alert variant="destructive" icon>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !ready}>
          {sender ? t(M['email_senders.save_change']) : t(M['email_senders.save_add'])}
        </Button>
        {sender ? (
          <Button type="button" variant="ghost" onClick={() => onDone(null)}>
            {t(M['email_senders.cancel'])}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
