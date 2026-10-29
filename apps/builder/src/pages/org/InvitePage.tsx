import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { defineMessages, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import { api, loadSession, userOrgSchema, useSessionStore } from '@/auth/client';
import { Button } from '@/components/ui/button';
import { AuthLayout, FormError } from '@/pages/auth/AuthLayout';
import { useFragment } from '@/pages/auth/useFinishSignIn';
import { problemText } from '@/pages/auth/util';
import { forgetInvite, pendingInvite, rememberInvite } from '@/org/pendingInvite';
import { roleLabel } from './roles';

const M = defineMessages('builder', {
  'invite.title': 'Join an organisation',
  'invite.loading': 'One moment…',
  'invite.missing': 'This page needs the link from your invitation email. Open it again, or ask for a new one.',
  'invite.from': '{inviter} invited {email} to {org} as {role}.',
  'invite.accept': 'Join {org}',
  'invite.busy': 'Joining…',
  'invite.sign_in': 'Sign in as {email} to accept',
  'invite.sign_up': 'No account yet? Create one with {email}',
  'invite.other_account': 'You are signed in as {current}. The invitation is for {email}: sign out and sign in with that address.',
  'invite.used': 'This invitation was used already.',
  'invite.revoked': 'This invitation was withdrawn.',
  'invite.expired': 'This invitation has expired. Ask for a new one.',
  'invite.org_inactive': 'This organisation is not active.',
  'invite.back': 'Back to forms',
});

const infoSchema = z.object({
  orgName: z.string(),
  email: z.string(),
  role: z.string(),
  inviterName: z.string(),
  state: z.enum(['open', 'used', 'revoked', 'expired', 'org_inactive']),
  expiresAt: z.string(),
});
type Info = z.infer<typeof infoSchema>;

const CLOSED: Record<Exclude<Info['state'], 'open'>, MessageId> = {
  used: M['invite.used'],
  revoked: M['invite.revoked'],
  expired: M['invite.expired'],
  org_inactive: M['invite.org_inactive'],
};

/**
 * `/invite#token=…`: who invites whom to which org, then accept as the signed-in user. Signed out, the token waits
 * through sign-in or sign-up and this page opens again afterwards.
 */
export function InvitePage() {
  const navigate = useNavigate();
  const session = useSessionStore();
  const fromLink = useFragment('token');
  const [token] = useState(() => fromLink ?? pendingInvite());
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(token ? null : t(M['invite.missing']));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (session.status === 'unknown') void loadSession();
  }, [session.status]);

  useEffect(() => {
    if (!token) return;
    let live = true;
    api('POST', '/v1/invites/lookup', infoSchema, { token }).then(
      (r) => {
        if (!live) return;
        setInfo(r);
        if (r.state !== 'open') forgetInvite();
      },
      (err: unknown) => {
        if (!live) return;
        forgetInvite();
        setError(problemText(err));
      },
    );
    return () => {
      live = false;
    };
  }, [token]);

  const accept = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/v1/invites/accept', z.object({ org: userOrgSchema, outcome: z.string() }), { token });
      forgetInvite();
      await loadSession();
      navigate('/org/members', { replace: true });
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  };

  const signInFirst = (path: '/auth/sign-in' | '/auth/sign-up') => {
    if (token) rememberInvite(token);
    navigate(path);
  };

  const footer = (
    <Link to="/forms" className="font-medium text-zinc-900 underline-offset-2 hover:underline">
      {t(M['invite.back'])}
    </Link>
  );
  const role = info ? roleLabel(info.role) : '';

  return (
    <AuthLayout title={t(M['invite.title'])} footer={footer}>
      {info ? (
        <div className="space-y-4">
          <p className="text-[14px]">{t(M['invite.from'], { inviter: info.inviterName, email: info.email, org: info.orgName, role })}</p>
          {info.state !== 'open' ? (
            <FormError message={t(CLOSED[info.state])} />
          ) : session.status === 'signed_in' ? (
            session.me.user.email.toLowerCase() === info.email.toLowerCase() ? (
              <Button className="w-full" disabled={busy} onClick={() => void accept()}>
                {busy ? t(M['invite.busy']) : t(M['invite.accept'], { org: info.orgName })}
              </Button>
            ) : (
              <FormError message={t(M['invite.other_account'], { current: session.me.user.email, email: info.email })} />
            )
          ) : session.status === 'signed_out' ? (
            <div className="space-y-2">
              <Button className="w-full" onClick={() => signInFirst('/auth/sign-in')}>
                {t(M['invite.sign_in'], { email: info.email })}
              </Button>
              <Button className="w-full" variant="outline" onClick={() => signInFirst('/auth/sign-up')}>
                {t(M['invite.sign_up'], { email: info.email })}
              </Button>
            </div>
          ) : null}
          <FormError message={error} />
        </div>
      ) : error ? (
        <FormError message={error} />
      ) : (
        <p className="text-[14px] text-[var(--notion-text-muted)]">{t(M['invite.loading'])}</p>
      )}
    </AuthLayout>
  );
}
