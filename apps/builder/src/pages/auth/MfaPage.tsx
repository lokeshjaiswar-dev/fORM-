import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { api, signInResultSchema } from '@/auth/client';
import { Button, Input, TextLink } from '@dmacq/ui';
import { AuthLayout, Field, FormError } from './AuthLayout';
import { useFinishSignIn, useFragment } from './useFinishSignIn';
import { problemText, submit } from './util';

const M = defineMessages('builder', {
  'mfa.title': 'Two-factor sign-in',
  'mfa.totp_description': 'Enter the 6-digit code from your authenticator app.',
  'mfa.recovery_description': 'Enter one of the recovery codes you saved when you turned on two-factor sign-in. Each works once.',
  'mfa.code': 'Authentication code',
  'mfa.recovery_code': 'Recovery code',
  'mfa.submit': 'Verify',
  'mfa.busy': 'Verifying…',
  'mfa.use_recovery': 'Use a recovery code instead',
  'mfa.use_totp': 'Use your authenticator app instead',
  'mfa.expired': 'This sign-in attempt has expired. Sign in again.',
  'mfa.back': 'Back to sign in',
  'mfa.codes_left': '{n, plural, one {# recovery code left} other {# recovery codes left}}. Make new ones under Security.',
});

/** The second factor, with the ticket from sign-in (navigation state) or from an OAuth callback (`#ticket=`). */
export function MfaPage() {
  const location = useLocation();
  const fromFragment = useFragment('ticket');
  const ticket = (location.state as { ticket?: unknown } | null)?.ticket;
  const finish = useFinishSignIn();
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = typeof ticket === 'string' ? ticket : fromFragment;

  if (!current) {
    return (
      <AuthLayout title={t(M['mfa.title'])}>
        <div className="space-y-3">
          <FormError message={t(M['mfa.expired'])} />
          <TextLink asChild size="small">
            <Link to="/auth/sign-in">{t(M['mfa.back'])}</Link>
          </TextLink>
        </div>
      </AuthLayout>
    );
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      const result = await api('POST', mode === 'totp' ? '/v1/auth/mfa/totp' : '/v1/auth/mfa/recovery', signInResultSchema, { ticket: current, code });
      if (result.status === 'signed_in' && result.recoveryCodesLeft !== undefined) toast(t(M['mfa.codes_left'], { n: result.recoveryCodesLeft }));
      await finish(result);
    } catch (err) {
      setError(problemText(err));
      setBusy(false);
    }
  }

  return (
    <AuthLayout title={t(M['mfa.title'])} description={t(M[mode === 'totp' ? 'mfa.totp_description' : 'mfa.recovery_description'])}>
      <form className="space-y-3" onSubmit={submit(() => void verify())}>
        <Field label={t(M[mode === 'totp' ? 'mfa.code' : 'mfa.recovery_code'])}>
          <Input
            autoFocus
            required
            autoComplete="one-time-code"
            inputMode={mode === 'totp' ? 'numeric' : 'text'}
            maxLength={mode === 'totp' ? 6 : 19}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t(M['mfa.busy']) : t(M['mfa.submit'])}
        </Button>
        <TextLink
          asChild
          size="small"
          color="neutral"
          className="justify-center"
        >
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'totp' ? 'recovery' : 'totp');
              setCode('');
              setError(null);
            }}
          >
            {t(M[mode === 'totp' ? 'mfa.use_recovery' : 'mfa.use_totp'])}
          </button>
        </TextLink>
      </form>
    </AuthLayout>
  );
}
