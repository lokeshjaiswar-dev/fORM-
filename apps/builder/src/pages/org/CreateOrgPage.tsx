import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { defineMessages, SUPPORTED_DATE_PATTERNS } from '@form/i18n';
import { t } from '@/i18n';
import { api, loadSession, useSessionStore } from '@/auth/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AuthLayout, Field, FormError } from '@/pages/auth/AuthLayout';
import { problemText, submit } from '@/pages/auth/util';

const M = defineMessages('builder', {
  'org_new.title': 'Create an organisation',
  'org_new.description': 'Forms, members and settings belong to an organisation. You will be its owner.',
  'org_new.name': 'Organisation name',
  'org_new.defaults': 'Defaults for new forms',
  'org_new.locale': 'Language',
  'org_new.time_zone': 'Time zone',
  'org_new.date_format': 'Date format',
  'org_new.create': 'Create organisation',
  'org_new.busy': 'Creating…',
  'org_new.back': 'Back to forms',
});

/** WSP-09: what a new org starts with; the API applies the same defaults. */
const ORG_DEFAULTS = { locale: 'en-IN', timeZone: 'Asia/Kolkata', dateFormat: 'DD-MM-YYYY' } as const;

const created = z.object({ org: z.object({ id: z.string() }) });

/** `/orgs/new`: name the org; the en-IN, Asia/Kolkata and DD-MM-YYYY defaults can be changed here or later. */
export function CreateOrgPage() {
  const navigate = useNavigate();
  const session = useSessionStore();
  const [name, setName] = useState('');
  const [locale, setLocale] = useState<string>(ORG_DEFAULTS.locale);
  const [timeZone, setTimeZone] = useState<string>(ORG_DEFAULTS.timeZone);
  const [dateFormat, setDateFormat] = useState<string>(ORG_DEFAULTS.dateFormat);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadSession().then((s) => {
      if (s.status === 'signed_out') navigate('/auth/sign-in', { replace: true });
    });
  }, [navigate]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/v1/orgs', created, { name, locale, timeZone, dateFormat });
      await loadSession();
      navigate('/org/members', { replace: true });
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <Link to="/forms" className="font-medium text-zinc-900 underline-offset-2 hover:underline">
      {t(M['org_new.back'])}
    </Link>
  );

  return (
    <AuthLayout title={t(M['org_new.title'])} description={t(M['org_new.description'])} footer={footer}>
      <form className="space-y-4" onSubmit={submit(() => void create())}>
        <Field label={t(M['org_new.name'])}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus />
        </Field>
        <fieldset className="space-y-3 rounded-md border border-[var(--notion-border)] p-3">
          <legend className="px-1 text-[12px] font-medium uppercase tracking-wide text-zinc-500">{t(M['org_new.defaults'])}</legend>
          <Field label={t(M['org_new.locale'])}>
            <Input value={locale} onChange={(e) => setLocale(e.target.value)} required maxLength={35} />
          </Field>
          <Field label={t(M['org_new.time_zone'])}>
            <Input value={timeZone} onChange={(e) => setTimeZone(e.target.value)} required maxLength={64} />
          </Field>
          <Field label={t(M['org_new.date_format'])}>
            <select value={dateFormat} onChange={(e) => setDateFormat(e.target.value)} className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm">
              {SUPPORTED_DATE_PATTERNS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
        </fieldset>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy || session.status !== 'signed_in'}>
          {busy ? t(M['org_new.busy']) : t(M['org_new.create'])}
        </Button>
      </form>
    </AuthLayout>
  );
}
