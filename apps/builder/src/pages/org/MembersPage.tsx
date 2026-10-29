import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Copy, Settings } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { BUILDER_LOCALE, t } from '@/i18n';
import { loadSession, orgApi, useActiveOrg, useSessionStore } from '@/auth/client';
import { AccountMenu } from '@/auth/AccountMenu';
import { Badge, Button, Field, Input, TextLink } from '@dmacq/ui';
import { NiceSelect } from '@/components/NiceSelect';
import { FormError, Notice } from '@/pages/auth/AuthLayout';
import { problemText, submit } from '@/pages/auth/util';
import {
  accessLinkSchema,
  assignable,
  canManage,
  invitedSchema,
  invitesSchema,
  membersSchema,
  orgSchema,
  type InviteRow,
  type Members,
  type OrgInfo,
} from './orgApi';
import { roleLabel } from './roles';


const M = defineMessages('builder', {
  'members.title': 'Members',
  'members.loading': 'Loading…',
  'members.no_org': 'You are not in an organisation yet.',
  'members.create_org': 'Create one',
  'members.list': 'Members of {org}',
  'members.you': '(you)',
  'members.suspended': 'Suspended',
  'members.role_of': 'Role of {email}',
  'members.remove': 'Remove',
  'members.leave': 'Leave',
  'members.suspend': 'Suspend',
  'members.reactivate': 'Reactivate',
  'members.access_link': 'Sign-in link',
  'members.access_link_shown': 'One-time link for {email}, valid for 60 minutes. It is shown only now: hand it over yourself.',
  'members.invite': 'Invite someone',
  'members.invite_email': 'Email address',
  'members.invite_role': 'Role',
  'members.invite_send': 'Invite',
  'members.invited_emailed': 'Invitation emailed to {email}. You can also share this link:',
  'members.invited_link': 'This server sends no email: give {email} this link yourself.',
  'members.copy': 'Copy link',
  'members.copied': 'Copied',
  'members.invites': 'Open invitations',
  'members.invites_none': 'No open invitations.',
  'members.invite_expires': 'expires {date}',
  'members.invite_expired': 'expired',
  'members.withdraw': 'Withdraw',
  'members.settings': 'Organisation settings',
  'members.back': 'Back to forms',
  'members.left': 'You left {org}.',
});

const date = new Intl.DateTimeFormat(BUILDER_LOCALE, { dateStyle: 'medium' });

interface Loaded {
  info: OrgInfo;
  members: Members;
  invites: InviteRow[];
}

/** `/org/members`: who is in the active org, their roles, invitations, and leaving. */
export function MembersPage() {
  const navigate = useNavigate();
  const session = useSessionStore();
  const active = useActiveOrg();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; link?: string } | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (session.status === 'unknown') void loadSession();
    if (session.status === 'signed_out') navigate('/auth/sign-in', { replace: true });
  }, [session.status, navigate]);

  const fetchOrg = useCallback(async (): Promise<Loaded> => {
    const info = await orgApi('GET', '/v1/org', orgSchema);
    const manage = info.permissions.includes('members.manage');
    const [members, invites] = await Promise.all([
      orgApi('GET', '/v1/org/members', membersSchema),
      manage ? orgApi('GET', '/v1/org/invites', invitesSchema).then((r) => r.items) : Promise.resolve([]),
    ]);
    return { info, members, invites };
  }, []);

  useEffect(() => {
    if (!active) return;
    let live = true;
    fetchOrg().then(
      (loaded) => live && setData(loaded),
      (err: unknown) => live && setError(problemText(err)),
    );
    return () => {
      live = false;
    };
  }, [active, fetchOrg]);

  const reload = async () => setData(await fetchOrg());

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <TextLink asChild size="small">
      <Link to="/forms">{t(M['members.back'])}</Link>
    </TextLink>
  );

  if (session.status === 'signed_in' && !active) {
    return (
      <Page footer={footer}>
        <p className="mt-6 text-[15px]">
          {t(M['members.no_org'])}{' '}
          <TextLink asChild>
            <Link to="/orgs/new">{t(M['members.create_org'])}</Link>
          </TextLink>
        </p>
      </Page>
    );
  }
  if (!data || session.status !== 'signed_in') {
    return (
      <Page footer={footer}>
        <FormError message={error} />
        {error ? null : <p className="mt-6 text-[14px] text-muted-foreground">{t(M['members.loading'])}</p>}
      </Page>
    );
  }

  const me = session.me.user.id;
  const actor = data.info.role;
  const manage = data.info.permissions.includes('members.manage');
  const orgName = data.info.org.name;

  const invite = () =>
    run(async () => {
      const r = await orgApi('POST', '/v1/org/invites', invitedSchema, { email, role });
      setEmail('');
      setCopied(false);
      setNotice({ text: t(r.emailed ? M['members.invited_emailed'] : M['members.invited_link'], { email: r.invite.email }), link: r.link });
      await reload();
    });
  const change = (userId: string, body: { role?: string; status?: string }) =>
    run(async () => {
      await orgApi('PATCH', `/v1/org/members/${userId}`, null, body);
      await reload();
    });
  const remove = (userId: string) =>
    run(async () => {
      await orgApi('DELETE', `/v1/org/members/${userId}`, null);
      if (userId === me) {
        await loadSession();
        setNotice({ text: t(M['members.left'], { org: orgName }) });
        return;
      }
      await reload();
    });
  const accessLink = (userId: string, memberEmail: string) =>
    run(async () => {
      const r = await orgApi('POST', `/v1/org/members/${userId}/access-link`, accessLinkSchema);
      setCopied(false);
      setNotice({ text: t(M['members.access_link_shown'], { email: memberEmail }), link: r.link });
    });
  const withdraw = (id: string) =>
    run(async () => {
      await orgApi('DELETE', `/v1/org/invites/${id}`, null);
      await reload();
    });
  const copy = (link: string) => {
    void navigator.clipboard?.writeText(link).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <Page footer={footer}>
      <div className="mt-2 flex items-center justify-between gap-4">
        <h2 className="text-[15px] font-semibold">{t(M['members.list'], { org: orgName })}</h2>
        {data.info.permissions.includes('org.settings') ? (
          <TextLink asChild size="small" color="neutral" icon={<Settings className="size-3.5" />}>
            <Link to="/org/settings">{t(M['members.settings'])}</Link>
          </TextLink>
        ) : null}
      </div>
      {notice ? (
        <Notice className="mt-4">
          {notice.text}
          {notice.link ? (
            <span className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-[12px] text-foreground">{notice.link}</code>
              <Button type="button" size="sm" variant="outline" onClick={() => copy(notice.link!)}>
                <Copy /> {copied ? t(M['members.copied']) : t(M['members.copy'])}
              </Button>
            </span>
          ) : null}
        </Notice>
      ) : null}
      <div className="mt-3">
        <FormError message={error} />
      </div>
      <ul className="mt-3 divide-y divide-border">
        {data.members.items.map((m) => {
          const self = m.userId === me;
          const editable = manage && !self && canManage(actor, m.role);
          return (
            <li key={m.userId} className="flex flex-wrap items-center gap-3 py-3 text-[14px]">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {m.name ?? m.email} {self ? <span className="font-normal text-muted-foreground">{t(M['members.you'])}</span> : null}
                </span>
                <span className="block truncate text-[13px] text-muted-foreground">{m.email}</span>
              </span>
              {m.status === 'suspended' ? <Badge variant="warning" size="sm">{t(M['members.suspended'])}</Badge> : null}
              {editable ? (
                <NiceSelect
                  size="sm"
                  aria-label={t(M['members.role_of'], { email: m.email })}
                  value={m.role}
                  disabled={busy}
                  onChange={(role) => void change(m.userId, { role })}
                  options={[...new Set([m.role, ...assignable(actor)])].map((r) => ({ value: r, label: roleLabel(r) }))}
                />
              ) : (
                <span className="text-[13px] text-muted-foreground">{roleLabel(m.role)}</span>
              )}
              {editable ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void change(m.userId, { status: m.status === 'suspended' ? 'active' : 'suspended' })}>
                  {m.status === 'suspended' ? t(M['members.reactivate']) : t(M['members.suspend'])}
                </Button>
              ) : null}
              {editable && data.members.accessLinks ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void accessLink(m.userId, m.email)}>
                  {t(M['members.access_link'])}
                </Button>
              ) : null}
              {self || editable ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void remove(m.userId)}>
                  {self ? t(M['members.leave']) : t(M['members.remove'])}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {manage ? (
        <>
          <h2 className="mt-8 text-[15px] font-semibold">{t(M['members.invite'])}</h2>
          <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={submit(() => void invite())}>
            <div className="min-w-[220px] flex-1">
              <Field label={t(M['members.invite_email'])}>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
              </Field>
            </div>
            <Field label={t(M['members.invite_role'])}>
              <NiceSelect
                aria-label={t(M['members.invite_role'])}
                value={role}
                onChange={setRole}
                options={assignable(actor).map((r) => ({ value: r, label: roleLabel(r) }))}
              />
            </Field>
            <Button type="submit" disabled={busy}>
              {t(M['members.invite_send'])}
            </Button>
          </form>
          <h2 className="mt-8 text-[15px] font-semibold">{t(M['members.invites'])}</h2>
          {data.invites.length === 0 ? (
            <p className="mt-2 text-[14px] text-muted-foreground">{t(M['members.invites_none'])}</p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {data.invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-3 py-2.5 text-[14px]">
                  <span className="min-w-0 flex-1 truncate">{i.email}</span>
                  <span className="text-[13px] text-muted-foreground">{roleLabel(i.role)}</span>
                  <span className="text-[13px] text-muted-foreground">
                    {i.state === 'expired' ? t(M['members.invite_expired']) : t(M['members.invite_expires'], { date: date.format(new Date(i.expiresAt)) })}
                  </span>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void withdraw(i.id)}>
                    {t(M['members.withdraw'])}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </Page>
  );
}

function Page({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-[720px] px-8 pb-24 pt-[72px] text-foreground">
      <div className="-mt-12 mb-6 flex justify-end">
        <AccountMenu />
      </div>
      <h1 className="text-[40px] font-bold leading-[1.15] tracking-[-0.02em]">{t(M['members.title'])}</h1>
      {children}
      <div className="mt-10">{footer}</div>
    </main>
  );
}
