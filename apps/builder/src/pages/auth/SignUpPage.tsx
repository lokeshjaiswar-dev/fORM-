import { useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { api, ApiProblem } from '@/auth/client';
import { Button, Input, TextLink } from '@dmacq/ui';
import { PrivacyNotice } from '../privacy/PrivacyNotice';
import { useNotice } from '../privacy/useNotice';
import { AuthLayout, Field, FormError, Notice } from './AuthLayout';
import { problemText, submit } from './util';

const M = defineMessages('builder', {
  'signup.title': 'Create your account',
  'signup.description': 'Build forms, collect responses and keep the data in your org.',
  'signup.name': 'Your name',
  'signup.email': 'Work email',
  'signup.password': 'Password',
  'signup.password_hint': 'At least 8 characters. Long passphrases are best; common passwords are refused.',
  'signup.notice': 'We use your name and email address to run your account, to sign you in and to send you account and security messages.',
  'signup.notice_read': 'Read the privacy notice: what we collect, why, how long we keep it, and your rights.',
  'signup.notice_accept': 'By creating an account you confirm that you have read the privacy notice (version {version}).',
  'signup.notice_loading': 'Loading the privacy notice…',
  'signup.notice_failed': 'The privacy notice cannot be loaded, so you cannot sign up yet.',
  'signup.notice_retry': 'Try again',
  'signup.submit': 'Create account',
  'signup.busy': 'Creating…',
  'signup.sent_title': 'Check your email',
  'signup.sent': 'We sent a link to {email}. Open it to confirm your address and sign in. The link works for 24 hours.',
  'signup.have_account': 'Already have an account?',
  'signup.sign_in': 'Sign in',
});

export function SignUpPage() {
  const { state: notice, reload } = useNotice();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function signUp() {
    if (notice.status !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/v1/auth/signup', z.object({ status: z.string() }), {
        email,
        password,
        ...(name.trim() ? { name: name.trim() } : {}),
        noticeVersion: notice.notice.version,
      });
      setSentTo(email.trim());
    } catch (err) {
      setError(problemText(err));
      // A newer notice came out meanwhile: show it before another try.
      if (err instanceof ApiProblem && err.code === 'NOTICE_OUTDATED') reload();
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <>
      {t(M['signup.have_account'])}{' '}
      <TextLink asChild size="small">
        <Link to="/auth/sign-in">{t(M['signup.sign_in'])}</Link>
      </TextLink>
    </>
  );

  if (sentTo) {
    return (
      <AuthLayout title={t(M['signup.sent_title'])} footer={footer}>
        <Notice>{t(M['signup.sent'], { email: sentTo })}</Notice>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t(M['signup.title'])} description={t(M['signup.description'])} footer={footer}>
      <form className="space-y-3" onSubmit={submit(() => void signUp())}>
        <Field label={t(M['signup.name'])}>
          <Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t(M['signup.email'])}>
          <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t(M['signup.password'])}>
          <Input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <p className="text-[12px] text-muted-foreground">{t(M['signup.password_hint'])}</p>
        <div className="space-y-2 rounded-md bg-state-hover px-3 py-2 text-[12px] text-muted-foreground">
          <p>{t(M['signup.notice'])}</p>
          {notice.status === 'ready' ? (
            <>
              <details>
                <summary className="cursor-pointer font-medium text-foreground">{t(M['signup.notice_read'])}</summary>
                <PrivacyNotice notice={notice.notice} headingLevel={3} className="mt-2 max-h-72 overflow-y-auto rounded border border-input bg-background p-3" />
              </details>
              <p>{t(M['signup.notice_accept'], { version: notice.notice.version })}</p>
            </>
          ) : notice.status === 'failed' ? (
            <div className="flex items-center justify-between gap-2">
              <span role="alert" className="text-destructive">
                {t(M['signup.notice_failed'])}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={reload}>
                {t(M['signup.notice_retry'])}
              </Button>
            </div>
          ) : (
            <p>{t(M['signup.notice_loading'])}</p>
          )}
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy || notice.status !== 'ready'}>
          {busy ? t(M['signup.busy']) : t(M['signup.submit'])}
        </Button>
      </form>
    </AuthLayout>
  );
}
