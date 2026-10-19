import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { api, fetchMethods, oauthStartUrl, signInResultSchema, type AuthMethods } from '@/auth/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useEdition } from '@/edition/edition';
import { useNotice } from '../privacy/useNotice';
import { AuthLayout, Field, FormError, Notice } from './AuthLayout';
import { useFinishSignIn, useFragment } from './useFinishSignIn';
import { problemText, submit } from './util';

const M = defineMessages('builder', {
  'signin.title': 'Sign in',
  'signin.description': 'Sign in to build and publish forms.',
  'signin.email': 'Email',
  'signin.password': 'Password',
  'signin.submit': 'Sign in',
  'signin.busy': 'Signing in…',
  'signin.magic': 'Email me a sign-in link',
  'signin.magic_sent': 'If an account uses {email}, a sign-in link is on its way. It works once, for 15 minutes.',
  'signin.magic_needs_email': 'Enter your email address first.',
  'signin.step_up': 'This account has had many sign-in attempts. If the password was right, a sign-in link is on its way to {email}.',
  'signin.forgot': 'Forgot password?',
  'signin.or': 'or',
  'signin.google': 'Continue with Google',
  'signin.microsoft': 'Continue with Microsoft',
  'signin.no_account': 'No account yet?',
  'signin.sign_up': 'Create one',
  'signin.oauth_failed': 'That sign-in did not work. Try again, or use your email address.',
  'signin.oauth_unverified': 'Your provider did not confirm that email address. Sign in with your email address instead.',
  'signin.oauth_unavailable': 'That sign-in provider cannot be reached right now.',
  'signin.oauth_notice': 'New accounts need the privacy notice first. Read it, then continue again.',
  'signin.oauth_notice_note': 'New to fORM-? Continuing with Google or Microsoft creates your account under our privacy notice.',
  'signin.privacy_notice': 'Read the privacy notice',
});

const OAUTH_ERRORS: Record<string, keyof typeof M> = {
  oauth_failed: 'signin.oauth_failed',
  oauth_email_unverified: 'signin.oauth_unverified',
  oauth_unavailable: 'signin.oauth_unavailable',
  oauth_notice: 'signin.oauth_notice',
};

/**
 * What the server offers: Google and Microsoft buttons never in an air-gapped edition (SaaS only), and the emailed
 * sign-in and reset links only when the deployment can send mail.
 */
function useSignInMethods(): { providers: AuthMethods['oauth']; emailLinks: boolean } {
  const edition = useEdition();
  const [offered, setOffered] = useState<Pick<AuthMethods, 'oauth' | 'emailLinks'>>({ oauth: [], emailLinks: true });
  useEffect(() => {
    let live = true;
    fetchMethods().then(
      (m) => live && setOffered(m),
      () => live && setOffered({ oauth: [], emailLinks: true }),
    );
    return () => {
      live = false;
    };
  }, []);
  return { providers: edition.airGapped || edition.deploymentMode !== 'saas' ? [] : offered.oauth, emailLinks: offered.emailLinks };
}

export function SignInPage() {
  const finish = useFinishSignIn();
  const oauthError = useFragment('error');
  const { providers, emailLinks } = useSignInMethods();
  // A first Google or Microsoft sign-in creates the account: the buttons carry the notice version shown here.
  const { state: notice } = useNotice();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(oauthError ? t(M[OAUTH_ERRORS[oauthError] ?? 'signin.oauth_failed']) : null);
  const [sent, setSent] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const result = await api('POST', '/v1/auth/login', signInResultSchema, { email, password });
      if (result.status === 'link_sent') {
        setSent(t(M['signin.step_up'], { email: email.trim() }));
        setBusy(false);
        return;
      }
      await finish(result);
    } catch (err) {
      setError(problemText(err));
      setBusy(false);
    }
  }

  async function magicLink() {
    setError(null);
    setSent(null);
    if (!email.trim()) {
      setError(t(M['signin.magic_needs_email']));
      return;
    }
    try {
      await api('POST', '/v1/auth/magic-link', z.object({ status: z.string() }), { email });
      setSent(t(M['signin.magic_sent'], { email: email.trim() }));
    } catch (err) {
      setError(problemText(err));
    }
  }

  return (
    <AuthLayout
      title={t(M['signin.title'])}
      description={t(M['signin.description'])}
      footer={
        <>
          {t(M['signin.no_account'])}{' '}
          <Link to="/auth/sign-up" className="font-medium text-zinc-900 underline-offset-2 hover:underline">
            {t(M['signin.sign_up'])}
          </Link>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit(() => void signIn())}>
        <Field label={t(M['signin.email'])}>
          <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t(M['signin.password'])}>
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <FormError message={error} />
        {sent ? <Notice>{sent}</Notice> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t(M['signin.busy']) : t(M['signin.submit'])}
        </Button>
        {emailLinks ? (
          <div className="flex items-center justify-between text-[13px]">
            <button type="button" className="text-zinc-700 underline-offset-2 hover:underline" onClick={() => void magicLink()}>
              {t(M['signin.magic'])}
            </button>
            <Link to="/auth/forgot" className="text-zinc-700 underline-offset-2 hover:underline">
              {t(M['signin.forgot'])}
            </Link>
          </div>
        ) : null}
      </form>
      {providers.length > 0 && notice.status === 'ready' ? (
        <div className="mt-5 space-y-2">
          <p className="text-center text-[12px] uppercase tracking-wide text-zinc-400">{t(M['signin.or'])}</p>
          {providers.map((p) => (
            <a
              key={p}
              href={oauthStartUrl(p, notice.notice.version)}
              className="flex h-9 w-full items-center justify-center rounded-md border border-zinc-200 bg-white text-sm font-medium hover:bg-zinc-50"
            >
              {t(M[p === 'google' ? 'signin.google' : 'signin.microsoft'])}
            </a>
          ))}
          <p className="text-center text-[12px] text-[var(--notion-text-muted)]">
            {t(M['signin.oauth_notice_note'])}{' '}
            <Link to="/privacy" className="font-medium text-zinc-800 underline underline-offset-2">
              {t(M['signin.privacy_notice'])}
            </Link>
          </p>
        </div>
      ) : null}
    </AuthLayout>
  );
}
