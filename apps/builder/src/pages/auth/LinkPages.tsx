import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { api, linkInfoSchema, signInResultSchema, type LinkInfo } from '@/auth/client';
import { Button, Input, TextLink } from '@dmacq/ui';
import { AuthLayout, Field, FormError } from './AuthLayout';
import { useFinishSignIn, useFragment } from './useFinishSignIn';
import { problemText, submit } from './util';

const M = defineMessages('builder', {
  'link.verify_title': 'Confirm your email',
  'link.magic_title': 'Sign in with your link',
  'link.working': 'One moment…',
  'link.for': 'This link is for {email}.',
  'link.continue': 'Continue as {email}',
  'link.busy': 'Signing in…',
  'link.password_hint': 'You are not in the browser you signed up in. Enter the password you chose to finish.',
  'link.password': 'Password',
  'link.not_mine': 'Did not sign up, or forgot the password? Reset it',
  'link.missing': 'This page needs the link from your email. Open the link again, or ask for a new one.',
  'link.back': 'Back to sign in',
});

type Purpose = 'verify_email' | 'magic_link';

const REDEEM: Record<Purpose, '/v1/auth/verify-email' | '/v1/auth/magic-link/verify'> = {
  verify_email: '/v1/auth/verify-email',
  magic_link: '/v1/auth/magic-link/verify',
};

/** One lookup per token, also when React runs the effect twice in development. */
const lookups = new Map<string, Promise<LinkInfo>>();

/**
 * An emailed link names its account first and is redeemed only on the click that confirms it, so a link that someone
 * else sends cannot silently sign this browser into their account.
 */
function LinkPage({ title, purpose }: { title: string; purpose: Purpose }) {
  const token = useFragment('token');
  const finish = useFinishSignIn();
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : t(M['link.missing']));

  useEffect(() => {
    if (!token) return;
    const key = `${purpose}:${token}`;
    let lookup = lookups.get(key);
    if (!lookup) {
      lookup = api('POST', '/v1/auth/link', linkInfoSchema, { token, purpose });
      lookups.set(key, lookup);
    }
    let live = true;
    lookup.then(
      (result) => live && setInfo(result),
      (err: unknown) => live && setError(problemText(err)),
    );
    return () => {
      live = false;
    };
  }, [token, purpose]);

  async function redeem() {
    if (!token || !info) return;
    setBusy(true);
    setError(null);
    try {
      await finish(await api('POST', REDEEM[purpose], signInResultSchema, info.passwordRequired ? { token, password } : { token }));
    } catch (err) {
      setError(problemText(err));
      setBusy(false);
    }
  }

  const back = (
    <TextLink asChild size="small">
      <Link to="/auth/sign-in">{t(M['link.back'])}</Link>
    </TextLink>
  );

  if (!info) {
    return (
      <AuthLayout title={title}>
        {error ? (
          <div className="space-y-3">
            <FormError message={error} />
            {back}
          </div>
        ) : (
          <p className="text-[14px] text-muted-foreground">{t(M['link.working'])}</p>
        )}
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={title} description={t(M['link.for'], { email: info.email })}>
      <form className="space-y-3" onSubmit={submit(() => void redeem())}>
        {info.passwordRequired ? (
          <>
            <p className="text-[13px] text-muted-foreground">{t(M['link.password_hint'])}</p>
            <Field label={t(M['link.password'])}>
              <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </>
        ) : null}
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t(M['link.busy']) : t(M['link.continue'], { email: info.email })}
        </Button>
        {info.passwordRequired ? (
          <TextLink asChild size="small" color="neutral">
            <Link to="/auth/forgot">{t(M['link.not_mine'])}</Link>
          </TextLink>
        ) : null}
      </form>
    </AuthLayout>
  );
}

/** `/auth/verify#token=…`, from the sign-up email. */
export function VerifyEmailPage() {
  return <LinkPage title={t(M['link.verify_title'])} purpose="verify_email" />;
}

/** `/auth/magic#token=…`, from a sign-in link email. */
export function MagicLinkPage() {
  return <LinkPage title={t(M['link.magic_title'])} purpose="magic_link" />;
}
