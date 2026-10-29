import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { defineMessages, formatDate, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import { api, download, loadSession, signOut, useSessionStore } from '@/auth/client';
import { Button, Input, Textarea, TextLink } from '@dmacq/ui';
import { NiceSelect } from '@/components/ui/select';
import { AuthLayout, Field, FormError, Notice } from '../auth/AuthLayout';
import { problemText, submit } from '../auth/util';
import { PrivacyNotice } from './PrivacyNotice';
import { useNotice } from './useNotice';

const M = defineMessages('builder', {
  'account_privacy.title': 'Privacy',
  'account_privacy.signed_in_as': 'Your account: {email}',
  'account_privacy.loading': 'Loading…',
  'account_privacy.back': 'Back to forms',
  'account_privacy.security': 'Security',
  'account_privacy.updated': 'We updated our privacy notice. Read the new version below, then confirm.',
  'account_privacy.ack': 'I have read the privacy notice',
  'account_privacy.acked': 'Thank you: we recorded that you read version {version}.',
  'account_privacy.notice_title': 'Privacy notice',
  'account_privacy.notice_failed': 'The privacy notice cannot be loaded right now.',
  'account_privacy.retry': 'Try again',
  'account_privacy.export_title': 'Your data',
  'account_privacy.export_text': 'Download everything we hold about your account as a JSON file: profile, sign-ins, sessions, organisations and your requests. Forms and responses belong to your organisations and are not included.',
  'account_privacy.export': 'Download my data',
  'account_privacy.exporting': 'Preparing…',
  'account_privacy.name': 'Your name',
  'account_privacy.save_name': 'Save name',
  'account_privacy.name_saved': 'Saved.',
  'account_privacy.requests_title': 'Questions, corrections and complaints',
  'account_privacy.requests_text': 'Write to {contact} at {email}, or send a request here. We answer within 90 days.',
  'account_privacy.category': 'Kind of request',
  'account_privacy.category.information': 'What do you hold about me?',
  'account_privacy.category.correction': 'Correct my data',
  'account_privacy.category.erasure': 'Erase my data',
  'account_privacy.category.nomination': 'Nominate someone to act for me',
  'account_privacy.category.complaint': 'Complaint',
  'account_privacy.category.other': 'Something else',
  'account_privacy.message': 'Your request',
  'account_privacy.send': 'Send request',
  'account_privacy.sent': 'Sent. Your reference is {reference}; we answer by {date}.',
  'account_privacy.request_line': '{reference} · {category} · {status} · answer by {date}',
  'account_privacy.status.open': 'open',
  'account_privacy.status.answered': 'answered',
  'account_privacy.status.closed': 'closed',
  'account_privacy.requests_list': 'Your requests',
  'account_privacy.delete_title': 'Delete your account',
  'account_privacy.delete_text': 'Deleting signs you out everywhere and removes you from your organisations. They keep their forms and responses; forms you own pass to another owner. Copies in backups expire within 35 days.',
  'account_privacy.delete_check': 'Delete my account…',
  'account_privacy.blocked': 'Your account cannot be deleted yet:',
  'account_privacy.blocker.sole_owner': 'You are the only owner of {org}. Make someone else an owner first, or delete the organisation.',
  'account_privacy.blocker.last_member': 'You are the only member of {org}. Delete the organisation first.',
  'account_privacy.blocker.no_owner_for_forms': '{org} has no other owner to take over your {count, plural, one {# form} other {# forms}}. Ask for someone to be made an owner first.',
  'account_privacy.leaving':
    'You leave {count, plural, one {# organisation} other {# organisations}}; {forms, plural, =0 {you own no forms there} one {the form you own passes} other {the # forms you own pass}} to another owner.',
  'account_privacy.reauth': 'For your safety, deleting needs a sign-in from the last {minutes} minutes.',
  'account_privacy.reauth_button': 'Sign out and sign in again',
  'account_privacy.confirm': 'Type your email address to confirm',
  'account_privacy.delete': 'Delete my account',
  'account_privacy.deleting': 'Deleting…',
  'account_privacy.deleted_title': 'Your account was deleted',
  'account_privacy.deleted': 'You are signed out everywhere and no longer a member of any organisation. Copies in our backups expire by {date}. We sent a confirmation to your email address.',
  'account_privacy.sign_up': 'Create a new account',
});

const CATEGORIES = ['information', 'correction', 'erasure', 'nomination', 'complaint', 'other'] as const;
type Category = (typeof CATEGORIES)[number];
const CATEGORY_LABEL: Record<Category, MessageId> = {
  information: M['account_privacy.category.information'],
  correction: M['account_privacy.category.correction'],
  erasure: M['account_privacy.category.erasure'],
  nomination: M['account_privacy.category.nomination'],
  complaint: M['account_privacy.category.complaint'],
  other: M['account_privacy.category.other'],
};
const STATUS_LABEL: Record<'open' | 'answered' | 'closed', MessageId> = {
  open: M['account_privacy.status.open'],
  answered: M['account_privacy.status.answered'],
  closed: M['account_privacy.status.closed'],
};
const BLOCKER_TEXT = {
  sole_owner: M['account_privacy.blocker.sole_owner'],
  last_member: M['account_privacy.blocker.last_member'],
  no_owner_for_forms: M['account_privacy.blocker.no_owner_for_forms'],
} as const;

const grievanceSchema = z.object({
  reference: z.string(),
  category: z.enum(CATEGORIES),
  message: z.string().nullable(),
  status: z.enum(['open', 'answered', 'closed']),
  createdAt: z.string(),
  dueAt: z.string(),
  closedAt: z.string().nullable(),
});
type Grievance = z.infer<typeof grievanceSchema>;

const planSchema = z.object({
  status: z.enum(['ready', 'blocked']),
  orgs: z.array(
    z.object({
      orgId: z.string(),
      slug: z.string(),
      name: z.string(),
      role: z.string(),
      formsOwned: z.number(),
      formsTo: z.string().nullable(),
      blocker: z.enum(['sole_owner', 'last_member', 'no_owner_for_forms']).nullable(),
    }),
  ),
  recentSignIn: z.boolean(),
  signInWithinMinutes: z.number(),
});
type DeletionPlan = z.infer<typeof planSchema>;

/** A date in the builder's time zone (India, UTC+05:30 all year), e.g. `17 Jan 2027`. */
const IST_OFFSET_MS = 330 * 60_000;
const istDate = (iso: string) => formatDate(new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10), 'D MMM YYYY');

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-3 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <h2 className="text-[16px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * `/account/privacy` (CMP-21): the platform privacy notice and its acknowledgement, the account export, privacy
 * requests to the platform's privacy contact, and account deletion with the org-ownership checks.
 */
export function PrivacyPage() {
  const navigate = useNavigate();
  const session = useSessionStore();
  const { state: notice, reload } = useNotice();
  const [deleted, setDeleted] = useState<string | null>(null);

  useEffect(() => {
    void loadSession().then((s) => {
      if (s.status === 'signed_out') navigate('/auth/sign-in', { replace: true });
    });
  }, [navigate]);

  if (deleted) {
    return (
      <AuthLayout
        title={t(M['account_privacy.deleted_title'])}
        footer={
          <TextLink asChild>
            <Link to="/auth/sign-up">{t(M['account_privacy.sign_up'])}</Link>
          </TextLink>
        }
      >
        <Notice>{t(M['account_privacy.deleted'], { date: istDate(deleted) })}</Notice>
      </AuthLayout>
    );
  }

  const footer = (
    <span className="space-x-3">
      <TextLink asChild>
        <Link to="/forms">{t(M['account_privacy.back'])}</Link>
      </TextLink>
      <TextLink asChild>
        <Link to="/account/security">{t(M['account_privacy.security'])}</Link>
      </TextLink>
    </span>
  );

  if (session.status !== 'signed_in') {
    return (
      <AuthLayout wide title={t(M['account_privacy.title'])} footer={footer}>
        <p className="text-[14px] text-muted-foreground">{t(M['account_privacy.loading'])}</p>
      </AuthLayout>
    );
  }
  const { me } = session;

  return (
    <AuthLayout wide title={t(M['account_privacy.title'])} description={t(M['account_privacy.signed_in_as'], { email: me.user.email })} footer={footer}>
      <div className="space-y-6">
        <Section title={t(M['account_privacy.notice_title'])}>
          {notice.status === 'ready' ? (
            <>
              <NoticeAcknowledgement version={notice.notice.version} hash={notice.notice.hash} current={me.notice?.current ?? true} onOutdated={reload} />
              <details open={me.notice?.current === false}>
                <summary className="cursor-pointer text-[13px] font-medium">{notice.notice.title}</summary>
                <PrivacyNotice notice={notice.notice} headingLevel={3} className="mt-3" />
              </details>
            </>
          ) : notice.status === 'failed' ? (
            <div className="flex items-center gap-2">
              <FormError message={t(M['account_privacy.notice_failed'])} />
              <Button variant="outline" size="sm" onClick={reload}>
                {t(M['account_privacy.retry'])}
              </Button>
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">{t(M['account_privacy.loading'])}</p>
          )}
        </Section>
        <DataSection name={me.user.name} />
        <RequestsSection contact={notice.status === 'ready' ? notice.notice.contact : null} />
        <DeleteSection email={me.user.email} onDeleted={setDeleted} />
      </div>
    </AuthLayout>
  );
}

function NoticeAcknowledgement({ version, hash, current, onOutdated }: { version: string; hash: string; current: boolean; onOutdated: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  if (done) return <Notice>{t(M['account_privacy.acked'], { version })}</Notice>;
  if (current) return null;
  const acknowledge = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/v1/me/notice', z.object({ version: z.string(), acknowledged: z.boolean() }), { version, hash });
      setDone(true);
      await loadSession();
    } catch (err) {
      setError(problemText(err));
      onOutdated();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
      <p>{t(M['account_privacy.updated'])}</p>
      <FormError message={error} />
      <Button size="sm" disabled={busy} onClick={() => void acknowledge()}>
        {t(M['account_privacy.ack'])}
      </Button>
    </div>
  );
}

function DataSection({ name: current }: { name: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(current ?? '');
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api('PATCH', '/v1/me', null, { name: name.trim() || null });
      setSaved(true);
      await loadSession();
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await download('/v1/me/export', 'form-account.json');
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t(M['account_privacy.export_title'])}>
      <form className="flex items-end gap-2" onSubmit={submit(() => void save())}>
        <div className="flex-1">
          <Field label={t(M['account_privacy.name'])}>
            <Input autoComplete="name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" variant="outline" disabled={busy || name.trim() === (current ?? '')}>
          {t(M['account_privacy.save_name'])}
        </Button>
      </form>
      {saved ? <Notice>{t(M['account_privacy.name_saved'])}</Notice> : null}
      <p className="text-[13px] text-muted-foreground">{t(M['account_privacy.export_text'])}</p>
      <FormError message={error} />
      <Button variant="outline" disabled={busy} onClick={() => void run()}>
        {busy ? t(M['account_privacy.exporting']) : t(M['account_privacy.export'])}
      </Button>
    </Section>
  );
}

function RequestsSection({ contact }: { contact: { name: string | null; email: string } | null }) {
  const [items, setItems] = useState<Grievance[]>([]);
  const [category, setCategory] = useState<Category>('information');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    api('GET', '/v1/me/grievances', z.object({ items: z.array(grievanceSchema) })).then(
      (r) => live && setItems(r.items),
      (err: unknown) => live && setError(problemText(err)),
    );
    return () => {
      live = false;
    };
  }, [version]);

  const send = async () => {
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const g = await api('POST', '/v1/me/grievances', grievanceSchema, { category, message });
      setSent(t(M['account_privacy.sent'], { reference: g.reference, date: istDate(g.dueAt) }));
      setMessage('');
      setVersion((n) => n + 1);
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t(M['account_privacy.requests_title'])}>
      {contact ? <p className="text-[13px] text-muted-foreground">{t(M['account_privacy.requests_text'], { contact: contact.name ?? contact.email, email: contact.email })}</p> : null}
      <form className="space-y-3" onSubmit={submit(() => void send())}>
        <Field label={t(M['account_privacy.category'])}>
          <NiceSelect
            aria-label={t(M['account_privacy.category'])}
            value={category}
            onChange={(v) => setCategory(v as Category)}
            options={CATEGORIES.map((c) => ({ value: c, label: t(CATEGORY_LABEL[c]) }))}
          />
        </Field>
        <Field label={t(M['account_privacy.message'])}>
          <Textarea required maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <FormError message={error} />
        {sent ? <Notice>{sent}</Notice> : null}
        <Button type="submit" variant="outline" disabled={busy || message.trim().length === 0}>
          {t(M['account_privacy.send'])}
        </Button>
      </form>
      {items.length > 0 ? (
        <ul aria-label={t(M['account_privacy.requests_list'])} className="space-y-1 text-[13px]">
          {items.map((g) => (
            <li key={g.reference}>
              {t(M['account_privacy.request_line'], { reference: g.reference, category: t(CATEGORY_LABEL[g.category]), status: t(STATUS_LABEL[g.status]), date: istDate(g.dueAt) })}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function DeleteSection({ email, onDeleted }: { email: string; onDeleted: (backupsExpireBy: string) => void }) {
  const navigate = useNavigate();
  const [plan, setPlan] = useState<DeletionPlan | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setPlan(await api('GET', '/v1/me/deletion', planSchema));
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api('POST', '/v1/me/delete', z.object({ status: z.literal('deleted'), backupsExpireBy: z.string() }), { confirmEmail: confirm });
      useSessionStore.setState({ status: 'signed_out' }, true);
      onDeleted(r.backupsExpireBy);
    } catch (err) {
      setError(problemText(err));
      setBusy(false);
    }
  };

  const blocked = plan?.orgs.filter((o) => o.blocker !== null) ?? [];
  return (
    <Section title={t(M['account_privacy.delete_title'])}>
      <p className="text-[13px] text-muted-foreground">{t(M['account_privacy.delete_text'])}</p>
      {plan === null ? (
        <>
          <FormError message={error} />
          <Button variant="outline" disabled={busy} onClick={() => void check()}>
            {t(M['account_privacy.delete_check'])}
          </Button>
        </>
      ) : plan.status === 'blocked' ? (
        <div className="space-y-1.5 text-[13px]" role="alert">
          <p className="font-medium">{t(M['account_privacy.blocked'])}</p>
          <ul className="list-disc space-y-1 pl-5">
            {blocked.map((o) => (
              <li key={o.orgId}>{t(BLOCKER_TEXT[o.blocker!], { org: o.name, count: o.formsOwned })}</li>
            ))}
          </ul>
        </div>
      ) : !plan.recentSignIn ? (
        <div className="space-y-2 text-[13px]">
          <p>{t(M['account_privacy.reauth'], { minutes: plan.signInWithinMinutes })}</p>
          <Button variant="outline" onClick={() => void signOut().finally(() => navigate('/auth/sign-in', { replace: true }))}>
            {t(M['account_privacy.reauth_button'])}
          </Button>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={submit(() => void remove())}>
          {plan.orgs.length > 0 ? (
            <p className="text-[13px]">{t(M['account_privacy.leaving'], { count: plan.orgs.length, forms: plan.orgs.reduce((n, o) => n + o.formsOwned, 0) })}</p>
          ) : null}
          <Field label={t(M['account_privacy.confirm'])}>
            <Input type="email" autoComplete="off" required value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={email} />
          </Field>
          <FormError message={error} />
          <Button type="submit" variant="destructive" disabled={busy || confirm.trim().toLowerCase() !== email.toLowerCase()}>
            {busy ? t(M['account_privacy.deleting']) : t(M['account_privacy.delete'])}
          </Button>
        </form>
      )}
    </Section>
  );
}
