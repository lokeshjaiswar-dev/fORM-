import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { defineMessages, SUPPORTED_DATE_PATTERNS } from '@form/i18n';
import { t } from '@/i18n';
import { loadSession, orgApi, useActiveOrg, useSessionStore } from '@/auth/client';
import { Button, Input, Switch, TextLink } from '@dmacq/ui';
import { NiceSelect } from '@/components/ui/select';
import { AuthLayout, Field, FormError, Notice } from '@/pages/auth/AuthLayout';
import { problemText, submit } from '@/pages/auth/util';
import { orgSchema, settingsSchema } from './orgApi';

const M = defineMessages('builder', {
  'org_settings.title': 'Organisation settings',
  'org_settings.loading': 'Loading…',
  'org_settings.name': 'Organisation name',
  'org_settings.locale': 'Language',
  'org_settings.time_zone': 'Time zone',
  'org_settings.date_format': 'Date format',
  'org_settings.defaults_hint': 'Defaults for new forms in this organisation.',
  'org_settings.editors_notice': 'Editors may approve privacy notices',
  'org_settings.invite_days': 'Invitations expire after (days)',
  'org_settings.save': 'Save',
  'org_settings.saved': 'Saved.',
  'org_settings.denied': 'Only owners and admins can change these settings.',
  'org_settings.back': 'Back to members',
});

interface Form {
  name: string;
  locale: string;
  timeZone: string;
  dateFormat: string;
  editorsApproveNotice: boolean;
  inviteDays: number;
}

/** `/org/settings`: the org's name and defaults (WSP-09) and its settings; owners and admins (org.settings). */
export function OrgSettingsPage() {
  const navigate = useNavigate();
  const session = useSessionStore();
  const active = useActiveOrg();
  const [form, setForm] = useState<Form | null>(null);
  const [initial, setInitial] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (session.status === 'unknown') void loadSession();
    if (session.status === 'signed_out') navigate('/auth/sign-in', { replace: true });
  }, [session.status, navigate]);

  useEffect(() => {
    if (!active) return;
    void (async () => {
      try {
        const info = await orgApi('GET', '/v1/org', orgSchema);
        if (!info.permissions.includes('org.settings')) {
          setError(t(M['org_settings.denied']));
          return;
        }
        const settings = await orgApi('GET', '/v1/org/settings', settingsSchema);
        const loaded = { name: info.org.name, locale: info.org.locale, timeZone: info.org.timeZone, dateFormat: info.org.dateFormat, ...settings };
        setForm(loaded);
        setInitial(loaded);
      } catch (err) {
        setError(problemText(err));
      }
    })();
  }, [active]);

  const save = async () => {
    if (!form || !initial) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const org = Object.fromEntries((['name', 'locale', 'timeZone', 'dateFormat'] as const).filter((k) => form[k] !== initial[k]).map((k) => [k, form[k]]));
      const settings = Object.fromEntries((['editorsApproveNotice', 'inviteDays'] as const).filter((k) => form[k] !== initial[k]).map((k) => [k, form[k]]));
      if (Object.keys(org).length > 0) await orgApi('PATCH', '/v1/org', null, org);
      if (Object.keys(settings).length > 0) await orgApi('PATCH', '/v1/org/settings', null, settings);
      setInitial(form);
      setNotice(t(M['org_settings.saved']));
      if (org.name !== undefined) await loadSession();
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));
  const footer = (
    <TextLink asChild>
      <Link to="/org/members">{t(M['org_settings.back'])}</Link>
    </TextLink>
  );

  return (
    <AuthLayout title={t(M['org_settings.title'])} footer={footer}>
      {form ? (
        <form className="space-y-4" onSubmit={submit(() => void save())}>
          {notice ? <Notice>{notice}</Notice> : null}
          <Field label={t(M['org_settings.name'])}>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} required maxLength={100} />
          </Field>
          <p className="text-[13px] text-muted-foreground">{t(M['org_settings.defaults_hint'])}</p>
          <Field label={t(M['org_settings.locale'])}>
            <Input value={form.locale} onChange={(e) => set('locale', e.target.value)} required maxLength={35} />
          </Field>
          <Field label={t(M['org_settings.time_zone'])}>
            <Input value={form.timeZone} onChange={(e) => set('timeZone', e.target.value)} required maxLength={64} />
          </Field>
          <Field label={t(M['org_settings.date_format'])}>
            <NiceSelect
              aria-label={t(M['org_settings.date_format'])}
              value={form.dateFormat}
              onChange={(v) => set('dateFormat', v)}
              options={SUPPORTED_DATE_PATTERNS.map((p) => ({ value: p, label: p }))}
            />
          </Field>
          <label className="flex items-center justify-between gap-3 text-[13px] font-medium text-foreground">
            {t(M['org_settings.editors_notice'])}
            <Switch checked={form.editorsApproveNotice} onCheckedChange={(v) => set('editorsApproveNotice', v)} aria-label={t(M['org_settings.editors_notice'])} />
          </label>
          <Field label={t(M['org_settings.invite_days'])}>
            <Input type="number" min={1} max={30} value={form.inviteDays} onChange={(e) => set('inviteDays', Number(e.target.value))} required />
          </Field>
          <FormError message={error} />
          <Button type="submit" className="w-full" disabled={busy}>
            {t(M['org_settings.save'])}
          </Button>
        </form>
      ) : error ? (
        <FormError message={error} />
      ) : (
        <p className="text-[14px] text-muted-foreground">{t(M['org_settings.loading'])}</p>
      )}
    </AuthLayout>
  );
}
