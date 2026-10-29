import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Plus, ShieldCheck, Users } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { Button, TextLink } from '@dmacq/ui';
import { NiceSelect } from '@/components/ui/select';
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
      <TextLink asChild size="small" color="neutral" icon={<Plus className="size-3.5" />}>
        <Link to="/orgs/new">{t(M['account.create_org'])}</Link>
      </TextLink>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <NiceSelect
        size="sm"
        aria-label={t(M['account.org'])}
        value={active.id}
        onChange={(id) => {
          setFailed(false);
          switchOrg(id).catch(() => setFailed(true));
        }}
        options={me.orgs.map((o) => ({ value: o.id, label: o.name }))}
      />
      <Button variant="ghost" size="icon-sm" asChild>
        <Link to="/orgs/new" aria-label={t(M['account.new_org'])} title={t(M['account.new_org'])}>
          <Plus className="size-4" />
        </Link>
      </Button>
      <TextLink asChild size="small" color="neutral" icon={<Users className="size-3.5" />}>
        <Link to="/org/members">{t(M['account.members'])}</Link>
      </TextLink>
      {failed ? (
        <span role="alert" className="text-destructive">
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
      <TextLink asChild size="small">
        <Link to="/auth/sign-in">{t(M['account.sign_in'])}</Link>
      </TextLink>
    );
  }
  if (session.status !== 'signed_in') return null;
  return (
    <nav aria-label={t(M['account.label'])} className="flex flex-wrap items-center justify-end gap-2 text-[13px]">
      <OrgSwitcher />
      <span className="max-w-[200px] truncate text-muted-foreground">{session.me.user.email}</span>
      <TextLink asChild size="small" color="neutral" icon={<ShieldCheck className="size-3.5" />}>
        <Link to="/account/security">{t(M['account.security'])}</Link>
      </TextLink>
      <TextLink
        asChild
        size="small"
        color="neutral"
        icon={<Lock className="size-3.5" />}
        {...(session.me.notice?.current === false ? { title: t(M['account.notice_updated']) } : {})}
      >
        <Link to="/account/privacy">
          {t(M['account.privacy'])}
          {session.me.notice?.current === false ? <span role="img" aria-label={t(M['account.notice_updated'])} className="size-1.5 rounded-full bg-notice" /> : null}
        </Link>
      </TextLink>
      <Button variant="ghost" size="sm" onClick={() => void signOut()}>
        {t(M['account.sign_out'])}
      </Button>
    </nav>
  );
}
