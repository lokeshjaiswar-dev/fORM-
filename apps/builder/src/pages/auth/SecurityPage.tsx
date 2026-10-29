import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { api, loadSession, signOut, useSessionStore } from '@/auth/client';
import { QrCode } from '@/auth/QrCode';
import { Button, Input, Separator, TextLink } from '@dmacq/ui';
import { AuthLayout, Field, FormError, Notice } from './AuthLayout';
import { problemText, submit } from './util';

const M = defineMessages('builder', {
  'security.title': 'Security',
  'security.signed_in_as': 'Signed in as {email}',
  'security.loading': 'Loading…',
  'security.totp_off': 'Two-factor sign-in is off. Turn it on to ask for a code from an authenticator app at every sign-in.',
  'security.totp_on': 'Two-factor sign-in is on.',
  'security.enable': 'Set up two-factor sign-in',
  'security.scan': 'Scan this code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …), or enter the key by hand.',
  'security.qr': 'QR code for your authenticator app',
  'security.key': 'Setup key',
  'security.code': 'Code from the app',
  'security.confirm': 'Turn on',
  'security.codes_title': 'Save your recovery codes',
  'security.codes': 'Each code signs you in once if you lose your authenticator. They are shown only now: store them somewhere safe.',
  'security.codes_list': 'Recovery codes',
  'security.codes_done': 'I saved them',
  'security.disable_code': 'Code from the app, or a recovery code',
  'security.disable': 'Turn off two-factor sign-in',
  'security.new_codes': 'Make new recovery codes',
  'security.disabled': 'Two-factor sign-in is off.',
  'security.sign_out': 'Sign out',
  'security.back': 'Back to forms',
});

type Step = { kind: 'idle' } | { kind: 'setup'; secret: string; uri: string } | { kind: 'codes'; codes: string[] };

const codesSchema = z.object({ recoveryCodes: z.array(z.string()) });

/** `/account/security`: TOTP enrolment with the recovery codes, turning it off, new codes, sign-out. */
export function SecurityPage() {
  const navigate = useNavigate();
  const session = useSessionStore();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadSession().then((s) => {
      if (s.status === 'signed_out') navigate('/auth/sign-in', { replace: true });
    });
  }, [navigate]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  }

  const start = () =>
    run(async () => {
      const r = await api('POST', '/v1/auth/mfa/totp/setup', z.object({ secret: z.string(), otpauthUri: z.string() }));
      setCode('');
      setStep({ kind: 'setup', secret: r.secret, uri: r.otpauthUri });
    });
  const confirm = () =>
    run(async () => {
      const r = await api('POST', '/v1/auth/mfa/totp/verify', codesSchema, { code });
      setCode('');
      setStep({ kind: 'codes', codes: r.recoveryCodes });
    });
  const disable = () =>
    run(async () => {
      await api('POST', '/v1/auth/mfa/totp/disable', null, { code });
      setCode('');
      setNotice(t(M['security.disabled']));
      await loadSession();
    });
  const newCodes = () =>
    run(async () => {
      const r = await api('POST', '/v1/auth/mfa/recovery-codes', codesSchema, { code });
      setCode('');
      setStep({ kind: 'codes', codes: r.recoveryCodes });
    });

  const footer = (
    <TextLink asChild>
      <Link to="/forms">{t(M['security.back'])}</Link>
    </TextLink>
  );

  if (session.status !== 'signed_in') {
    return (
      <AuthLayout title={t(M['security.title'])} footer={footer}>
        <p className="text-[14px] text-muted-foreground">{t(M['security.loading'])}</p>
      </AuthLayout>
    );
  }
  const { user } = session.me;

  return (
    <AuthLayout title={t(M['security.title'])} description={t(M['security.signed_in_as'], { email: user.email })} footer={footer}>
      <div className="space-y-4">
        {notice ? <Notice>{notice}</Notice> : null}
        {step.kind === 'codes' ? (
          <div className="space-y-3">
            <h2 className="text-[15px] font-semibold">{t(M['security.codes_title'])}</h2>
            <p className="text-[13px] text-muted-foreground">{t(M['security.codes'])}</p>
            <ul aria-label={t(M['security.codes_list'])} className="grid grid-cols-2 gap-1.5 rounded-md bg-state-hover p-3 font-mono text-[13px]">
              {step.codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <Button
              className="w-full"
              onClick={() => {
                setStep({ kind: 'idle' });
                void loadSession();
              }}
            >
              {t(M['security.codes_done'])}
            </Button>
          </div>
        ) : step.kind === 'setup' ? (
          <form className="space-y-3" onSubmit={submit(() => void confirm())}>
            <p className="text-[13px] text-muted-foreground">{t(M['security.scan'])}</p>
            <QrCode value={step.uri} label={t(M['security.qr'])} className="mx-auto size-44" />
            <Field label={t(M['security.key'])}>
              <Input readOnly value={step.secret.replace(/(.{4})/g, '$1 ').trim()} className="font-mono" />
            </Field>
            <Field label={t(M['security.code'])}>
              <Input required inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <FormError message={error} />
            <Button type="submit" className="w-full" disabled={busy}>
              {t(M['security.confirm'])}
            </Button>
          </form>
        ) : user.totpEnabled ? (
          <form className="space-y-3" onSubmit={submit(() => void disable())}>
            <p className="text-[14px]">{t(M['security.totp_on'])}</p>
            <Field label={t(M['security.disable_code'])}>
              <Input required autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <FormError message={error} />
            <div className="flex gap-2">
              <Button type="submit" variant="outline" disabled={busy}>
                {t(M['security.disable'])}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void newCodes()}>
                {t(M['security.new_codes'])}
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <p className="text-[14px] text-muted-foreground">{t(M['security.totp_off'])}</p>
            <FormError message={error} />
            <Button className="w-full" disabled={busy} onClick={() => void start()}>
              {t(M['security.enable'])}
            </Button>
          </div>
        )}
        <Separator />
        <Button
          variant="outline"
          className="w-full"
          onClick={() =>
            void signOut().finally(() => {
              navigate('/auth/sign-in', { replace: true });
            })
          }
        >
          {t(M['security.sign_out'])}
        </Button>
      </div>
    </AuthLayout>
  );
}
