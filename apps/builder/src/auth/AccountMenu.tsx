import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Plus, ShieldCheck, Users } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { Button } from '@/components/ui/button';
import { activeOrgOf, loadSession, signOut, switchOrg, useSessionStore } from './client';

const M = defineMessages('builder', {
  'account.sign_in': 'Sign in',
  'account.security': 'Security',
  'account.privacy': 'Privacy',
  'account.notice_updated': 'Privacy notice updated',
  'account.sign_out': 'Sign out',
  'account.label': 'Account',
  'account.org': 'Organisation',
  'account.members': 'Members',
  'account.new_org': 'New organisation',
  'account.create_org': 'Create an organisation',
  'account.switch_failed': 'Could not switch the organisation. Try again.',
});

/** The org switcher: the orgs from `list_user_orgs()`; the session remembers the choice. */
export function OrgSwitcher() {
  const session = useSessionStore();
  const [failed, setFailed] = useState(false);
  if (session.status !== 'signed_in') return null;
  const { me } = session;
  const active = activeOrgOf(me);
  if (!active) {
    return (
      <Link to="/orgs/new" className="inline-flex items-center gap-1 font-medium text-zinc-700 underline-offset-2 hover:underline">
        <Plus className="size-3.5" /> {t(M['account.create_org'])}
      </Link>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <select
        aria-label={t(M['account.org'])}
        value={active.id}
        onChange={(e) => {
          setFailed(false);
          switchOrg(e.target.value).catch(() => setFailed(true));
        }}
        className="h-8 max-w-[180px] truncate rounded-md border border-zinc-200 bg-white px-2 text-[13px]"
      >
        {me.orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <Link to="/orgs/new" aria-label={t(M['account.new_org'])} title={t(M['account.new_org'])} className="text-zinc-500 hover:text-zinc-900">
        <Plus className="size-4" />
      </Link>
      <Link to="/org/members" className="inline-flex items-center gap-1 font-medium text-zinc-700 underline-offset-2 hover:underline">
        <Users className="size-3.5" /> {t(M['account.members'])}
      </Link>
      {failed ? (
        <span role="alert" className="text-red-600">
          {t(M['account.switch_failed'])}
        </span>
      ) : null}
    </span>
  );
}

/** Who is signed in, the org switcher, Security, Privacy and Sign out; a Sign in link otherwise. Nothing while the API is unreachable. */
export function AccountMenu() {
  const session = useSessionStore();

  useEffect(() => {
    if (session.status === 'unknown') void loadSession();
  }, [session.status]);

  if (session.status === 'signed_out') {
    return (
      <Link to="/auth/sign-in" className="text-[13px] font-medium text-zinc-700 underline-offset-2 hover:underline">
        {t(M['account.sign_in'])}
      </Link>
    );
  }
  if (session.status !== 'signed_in') return null;
  return (
    <nav aria-label={t(M['account.label'])} className="flex flex-wrap items-center justify-end gap-2 text-[13px]">
      <OrgSwitcher />
      <span className="max-w-[200px] truncate text-[var(--notion-text-muted)]">{session.me.user.email}</span>
      <Link to="/account/security" className="inline-flex items-center gap-1 font-medium text-zinc-700 underline-offset-2 hover:underline">
        <ShieldCheck className="size-3.5" /> {t(M['account.security'])}
      </Link>
      <Link
        to="/account/privacy"
        className="inline-flex items-center gap-1 font-medium text-zinc-700 underline-offset-2 hover:underline"
        {...(session.me.notice?.current === false ? { title: t(M['account.notice_updated']) } : {})}
      >
        <Lock className="size-3.5" /> {t(M['account.privacy'])}
        {session.me.notice?.current === false ? <span role="img" aria-label={t(M['account.notice_updated'])} className="size-1.5 rounded-full bg-amber-500" /> : null}
      </Link>
      <Button variant="ghost" size="sm" onClick={() => void signOut()}>
        {t(M['account.sign_out'])}
      </Button>
    </nav>
  );
}
