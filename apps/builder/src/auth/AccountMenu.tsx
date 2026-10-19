import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Lock, ShieldCheck } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { Button } from '@/components/ui/button';
import { loadSession, signOut, useSessionStore } from './client';

const M = defineMessages('builder', {
  'account.sign_in': 'Sign in',
  'account.security': 'Security',
  'account.privacy': 'Privacy',
  'account.notice_updated': 'Privacy notice updated',
  'account.sign_out': 'Sign out',
  'account.label': 'Account',
});

/** Who is signed in, with Security and Sign out; a Sign in link otherwise. Nothing while the API is unreachable. */
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
    <nav aria-label={t(M['account.label'])} className="flex items-center gap-2 text-[13px]">
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
