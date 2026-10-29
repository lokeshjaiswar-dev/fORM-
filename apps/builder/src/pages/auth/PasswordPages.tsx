import { useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { api } from '@/auth/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AuthLayout, Field, FormError, Notice } from './AuthLayout';
import { useFragment } from './useFinishSignIn';
import { problemText, submit } from './util';

const M = defineMessages('builder', {
  'forgot.title': 'Reset your password',
  'forgot.description': 'We will email you a link to choose a new password.',
  'forgot.email': 'Email',
  'forgot.submit': 'Send reset link',
  'forgot.sent': 'If an account uses {email}, a reset link is on its way. It works once, for 1 hour.',
  'reset.title': 'Choose a new password',
  'reset.description': 'Resetting signs you out on every device.',
  'reset.password': 'New password',
  'reset.submit': 'Set password',
  'reset.done': 'Your password is changed. Sign in with it now.',
  'reset.missing': 'This page needs the link from your email. Ask for a new one.',
  'password.back': 'Back to sign in',
});

function Back() {
  return (
    <Link to="/auth/sign-in" className="font-medium text-zinc-900 underline-offset-2 hover:underline">
      {t(M['password.back'])}
    </Link>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/v1/auth/password/forgot', z.object({ status: z.string() }), { email });
      setSentTo(email.trim());
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title={t(M['forgot.title'])} description={t(M['forgot.description'])} footer={<Back />}>
      {sentTo ? (
        <Notice>{t(M['forgot.sent'], { email: sentTo })}</Notice>
      ) : (
        <form className="space-y-3" onSubmit={submit(() => void send())}>
          <Field label={t(M['forgot.email'])}>
            <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <FormError message={error} />
          <Button type="submit" className="w-full" disabled={busy}>
            {t(M['forgot.submit'])}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

/** `/auth/reset#token=…`, from the reset email. A refused password keeps the link usable. */
export function ResetPasswordPage() {
  const token = useFragment('token');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : t(M['reset.missing']));
  const [busy, setBusy] = useState(false);

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/v1/auth/password/reset', z.object({ status: z.literal('password_reset') }), { token, password });
      setDone(true);
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title={t(M['reset.title'])} description={t(M['reset.description'])} footer={<Back />}>
      {done ? (
        <Notice>{t(M['reset.done'])}</Notice>
      ) : token ? (
        <form className="space-y-3" onSubmit={submit(() => void reset())}>
          <Field label={t(M['reset.password'])}>
            <Input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <FormError message={error} />
          <Button type="submit" className="w-full" disabled={busy}>
            {t(M['reset.submit'])}
          </Button>
        </form>
      ) : (
        <FormError message={error} />
      )}
    </AuthLayout>
  );
}
