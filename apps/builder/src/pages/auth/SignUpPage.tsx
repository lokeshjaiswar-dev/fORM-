import { useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { api } from '@/auth/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  'signup.submit': 'Create account',
  'signup.busy': 'Creating…',
  'signup.sent_title': 'Check your email',
  'signup.sent': 'We sent a link to {email}. Open it to confirm your address and sign in. The link works for 24 hours.',
  'signup.have_account': 'Already have an account?',
  'signup.sign_in': 'Sign in',
});

export function SignUpPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function signUp() {
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/v1/auth/signup', z.object({ status: z.string() }), { email, password, ...(name.trim() ? { name: name.trim() } : {}) });
      setSentTo(email.trim());
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <>
      {t(M['signup.have_account'])}{' '}
      <Link to="/auth/sign-in" className="font-medium text-zinc-900 underline-offset-2 hover:underline">
        {t(M['signup.sign_in'])}
      </Link>
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
        <p className="text-[12px] text-[var(--notion-text-muted)]">{t(M['signup.password_hint'])}</p>
        <p className="rounded-md bg-[var(--notion-hover)] px-3 py-2 text-[12px] text-[var(--notion-text-muted)]">{t(M['signup.notice'])}</p>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t(M['signup.busy']) : t(M['signup.submit'])}
        </Button>
      </form>
    </AuthLayout>
  );
}
