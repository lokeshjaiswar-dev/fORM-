import { useState } from 'react';
import { Link } from 'react-router-dom';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { api, signInResultSchema } from '@/auth/client';
import { Button, Input, TextLink } from '@dmacq/ui';
import { AuthLayout, Field, FormError } from './AuthLayout';
import { useFinishSignIn } from './useFinishSignIn';
import { problemText, submit } from './util';

const M = defineMessages('builder', {
  'signup.title': 'Create your account',
  'signup.description': 'Your organisation is the tenant: forms, members and responses stay inside it.',
  'signup.name': 'Your name',
  'signup.email': 'Email',
  'signup.password': 'Password',
  'signup.org': 'Organisation name',
  'signup.password_hint': 'At least 8 characters.',
  'signup.submit': 'Create account',
  'signup.busy': 'Creating…',
  'signup.have_account': 'Already have an account?',
  'signup.sign_in': 'Sign in',
});

export function SignUpPage() {
  const finish = useFinishSignIn();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signUp() {
    setBusy(true);
    setError(null);
    try {
      const result = await api('POST', '/v1/auth/signup', signInResultSchema, {
        email,
        password,
        orgName: orgName.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      await finish(result);
    } catch (err) {
      setError(problemText(err));
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
        <Field label={t(M['signup.org'])}>
          <Input required maxLength={100} value={orgName} onChange={(e) => setOrgName(e.target.value)} />
        </Field>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t(M['signup.busy']) : t(M['signup.submit'])}
        </Button>
      </form>
    </AuthLayout>
  );
}
