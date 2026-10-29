import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { defineMessages, SUPPORTED_DATE_PATTERNS } from '@form/i18n';
import { t } from '@/i18n';
import { api, loadSession, useSessionStore } from '@/auth/client';
import { Button, Input, TextLink } from '@dmacq/ui';
import { NiceSelect } from '@/components/NiceSelect';
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
    <TextLink asChild size="small">
      <Link to="/forms">{t(M['org_new.back'])}</Link>
    </TextLink>
  );

  return (
    <AuthLayout title={t(M['org_new.title'])} description={t(M['org_new.description'])} footer={footer}>
      <form className="space-y-4" onSubmit={submit(() => void create())}>
        <Field label={t(M['org_new.name'])}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus />
        </Field>
        <fieldset className="space-y-3 rounded-md border border-border p-3">
          <legend className="px-1 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{t(M['org_new.defaults'])}</legend>
          <Field label={t(M['org_new.locale'])}>
            <Input value={locale} onChange={(e) => setLocale(e.target.value)} required maxLength={35} />
          </Field>
          <Field label={t(M['org_new.time_zone'])}>
            <Input value={timeZone} onChange={(e) => setTimeZone(e.target.value)} required maxLength={64} />
          </Field>
          <Field label={t(M['org_new.date_format'])}>
            <NiceSelect
              aria-label={t(M['org_new.date_format'])}
              value={dateFormat}
              onChange={setDateFormat}
              options={SUPPORTED_DATE_PATTERNS.map((p) => ({ value: p, label: p }))}
            />
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
