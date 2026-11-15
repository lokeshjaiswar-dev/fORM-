import { useCallback, useEffect, useState } from 'react';
import { defineMessages, type MessageId } from '@form/i18n';
import { Alert, AlertDescription, Button, Input, Label, Switch, Textarea } from '@dmacq/ui';
import { t, BUILDER_TIME_ZONE } from '@/i18n';
import { ApiProblem, useActiveOrg } from '@/auth/client';
import { RichEditor } from '@/components/editor/RichEditor';
import { cn } from '@/lib/utils';
import { problemText } from '@/pages/auth/util';
import { flushAutosave } from '@/persistence/autosave';
import {
  AccessConflict,
  AccessInvalid,
  SlugTaken,
  changeSlug,
  getAccess,
  getOrgTimeZone,
  getSlugs,
  removeFormPassword,
  saveAccess,
  setFormPassword,
  type AccessSettings,
  type FormSlugs,
} from '@/persistence/accessApi';
import { useDoc } from '@/state/documentStore';
import { AddressField } from '@/components/builder/access/AddressField';
import { PasswordField } from '@/components/builder/access/PasswordField';
import { WeeklyHours } from '@/components/builder/access/WeeklyHours';
import { formOf, inputFromForm, isBlankDoc, isChanged, type AccessForm, type FieldName, type FormProblem } from '@/components/builder/access/accessModel';
import { rememberAccess } from '@/components/builder/access/accessPreview';

const M = defineMessages('builder', {
  'access.title': 'Access',
  'access.loading': 'Loading access settings…',
  'access.sign_in': 'Sign in to change who can open this form.',
  'access.not_saved': 'This form is not on the server yet. It saves by itself a moment after you edit it.',
  'access.forbidden': 'You do not have permission to change access for this form.',
  'access.unreachable': 'The server cannot be reached. Check your connection and try again.',
  'access.retry': 'Try again',
  'access.close_form': 'Close form',
  'access.closed_message': 'Closed message',
  'access.closed_hint': 'Shown when the form is closed, including after its close date. Leave it empty for the standard wording.',
  'access.open_at': 'Opens',
  'access.close_at': 'Closes',
  'access.zone_hint': 'Dates and times are in {zone}.',
  'access.limit': 'Limit responses',
  'access.limit_hint': 'The form closes after this many responses. Leave empty for no limit.',
  'access.previous_hours': 'Keep taking answers for the previous version (hours)',
  'access.previous_hint': 'After you publish a change, people who were filling in the old version can still submit for this long.',
  'access.embed': 'Pages that may embed this form',
  'access.embed_hint': 'One https address per line, such as https://example.com. Saved now; it takes effect once forms are served from their own public host.',
  'access.redirects': 'Sites a redirect may go to',
  'access.redirects_hint': 'One host name per line, such as example.com. Leave empty for no restriction.',
  'access.save': 'Save access settings',
  'access.saved': 'Access settings saved.',
  'access.conflict': 'These settings were changed somewhere else, so they were reloaded. Check them and save again.',
  'access.refused': 'The server did not accept these settings: {detail}',
  'access.problem_date_invalid': 'Enter a real date and time.',
  'access.problem_close_before_open': 'The close time must be after the open time.',
  'access.problem_limit_invalid': 'Enter a whole number of 1 or more.',
  'access.problem_window_invalid': 'Each set of hours needs at least one day and two different times.',
  'access.problem_embed_invalid': 'Use https addresses with no path, such as https://example.com.',
  'access.problem_redirect_invalid': 'Use host names such as example.com, without https:// or a path.',
  'access.problem_hours_invalid': 'Enter a whole number from 0 to 720.',
});

const PROBLEM_TEXT: Readonly<Record<FormProblem, MessageId>> = {
  date_invalid: M['access.problem_date_invalid'],
  close_before_open: M['access.problem_close_before_open'],
  limit_invalid: M['access.problem_limit_invalid'],
  window_invalid: M['access.problem_window_invalid'],
  embed_invalid: M['access.problem_embed_invalid'],
  redirect_invalid: M['access.problem_redirect_invalid'],
  hours_invalid: M['access.problem_hours_invalid'],
};

type Blocked = 'sign_in' | 'not_saved' | 'forbidden' | 'unreachable';
type Load = { status: 'loading' } | { status: 'blocked'; reason: Blocked } | { status: 'ready'; settings: AccessSettings; zone: string; slugs: FormSlugs };

const BLOCKED_TEXT: Readonly<Record<Blocked, MessageId>> = {
  sign_in: M['access.sign_in'],
  not_saved: M['access.not_saved'],
  forbidden: M['access.forbidden'],
  unreachable: M['access.unreachable'],
};

/** Why the settings could not be read: the refusal that says the form is not on the server (404) or not the caller's to change (401, 403), else the server was not reachable. */
function blockedBy(err: unknown): Blocked {
  if (err instanceof ApiProblem) {
    if (err.status === 404) return 'not_saved';
    if (err.status === 401) return 'sign_in';
    if (err.status === 403) return 'forbidden';
  }
  return 'unreachable';
}

/**
 * The form's access on the server (WP-1.07): switched on or off with its closed screen, open and close times in the org's
 * time zone (sent as instants), weekly hours, a response limit, a password, embed and redirect allowlists, how long the
 * previous version keeps taking answers, and the public address. The settings are one save with `If-Match` (a stale
 * revision reloads them); the password and the address have their own calls. Nothing here is kept in this browser: a
 * form made before WP-1.07 has its old local password and closed state moved to the server when it opens.
 */
export function AccessPanel({ dark = false }: { dark?: boolean }) {
  const formId = useDoc((d) => d.formId);
  const org = useActiveOrg()?.id ?? null;
  // Another form or another org is another panel: its state starts over instead of showing the last one's.
  return <AccessSection key={`${org ?? ''}:${formId}`} org={org} formId={formId} dark={dark} />;
}

function AccessSection({ org, formId, dark }: { org: string | null; formId: string; dark: boolean }) {
  const [state, setLoad] = useState<Load>({ status: 'loading' });
  const [form, setForm] = useState<AccessForm | null>(null);
  const [problems, setProblems] = useState<Partial<Record<FieldName, FormProblem>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const load: Load = org === null ? { status: 'blocked', reason: 'sign_in' } : state;

  const show = useCallback(
    (settings: AccessSettings, zone: string, slugs: FormSlugs) => {
      setLoad({ status: 'ready', settings, zone, slugs });
      setForm(formOf(settings, zone));
      setProblems({});
      rememberAccess(formId, settings);
    },
    [formId],
  );

  useEffect(() => {
    if (org === null) return;
    let live = true;
    void (async () => {
      // A form made a moment ago may not be on the server yet: send what is pending before asking about it.
      await flushAutosave().catch(() => undefined);
      try {
        const [settings, slugs, zone] = await Promise.all([getAccess(org, formId), getSlugs(org, formId), getOrgTimeZone(org).catch(() => BUILDER_TIME_ZONE as string)]);
        if (live) show(settings, zone, slugs);
      } catch (err) {
        if (live) setLoad({ status: 'blocked', reason: blockedBy(err) });
      }
    })();
    return () => {
      live = false;
    };
  }, [org, formId, attempt, show]);

  const heading = <h3 className={cn('text-[13px] font-semibold', dark && 'text-sidebar-foreground')}>{t(M['access.title'])}</h3>;
  const field = dark ? 'border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground' : undefined;
  const labelCls = dark ? 'text-sidebar-foreground/80' : undefined;

  if (load.status === 'loading') {
    return (
      <section aria-label={t(M['access.title'])} aria-busy="true" className="space-y-2 border-t border-border/60 pt-4">
        {heading}
        <p className="text-[12px] text-muted-foreground">{t(M['access.loading'])}</p>
      </section>
    );
  }
  if (load.status === 'blocked') {
    return (
      <section aria-label={t(M['access.title'])} className="space-y-2 border-t border-border/60 pt-4">
        {heading}
        <p className="text-[12px] text-muted-foreground" role="status">{t(BLOCKED_TEXT[load.reason])}</p>
        {load.reason !== 'sign_in' && load.reason !== 'forbidden' ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setLoad({ status: 'loading' });
              setAttempt((n) => n + 1);
            }}
          >
            {t(M['access.retry'])}
          </Button>
        ) : null}
      </section>
    );
  }
  if (form === null) return null;

  const { settings, zone, slugs } = load;
  const set = (patch: Partial<AccessForm>) => {
    setForm({ ...form, ...patch });
    setNotice(null);
    setError(null);
  };
  const problem = (name: FieldName): string | undefined => (problems[name] ? t(PROBLEM_TEXT[problems[name]!]) : undefined);
  const dateField = (name: 'openAt' | 'closeAt', label: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`access-${name}`} className={labelCls}>{label}</Label>
      <Input id={`access-${name}`} type="datetime-local" className={field} value={form[name]} aria-invalid={problems[name] !== undefined} onChange={(e) => set(name === 'openAt' ? { openAt: e.target.value } : { closeAt: e.target.value })} />
      {problem(name) ? <p className="text-[12px] text-destructive" role="alert">{problem(name)}</p> : null}
    </div>
  );

  const reload = async () => {
    if (org === null) return;
    const [fresh, latest] = await Promise.all([getAccess(org, formId), getSlugs(org, formId)]);
    show(fresh, zone, latest);
  };

  /** Runs one server call. Null when it worked; otherwise the text for what it threw, for the caller to show next to its own control. */
  const run = async (work: () => Promise<void>): Promise<string | null> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      return null;
    } catch (err) {
      return err instanceof AccessInvalid ? t(M['access.refused'], { detail: err.fields.map((f) => `${f.path}: ${f.message}`).join('; ') || err.message }) : problemText(err);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (org === null) return;
    const built = inputFromForm(form, settings, zone);
    if (!built.ok) {
      setProblems(built.problems);
      return;
    }
    setProblems({});
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveAccess(org, formId, built.input, settings.rev);
      show(saved, zone, slugs);
      setNotice(t(M['access.saved']));
    } catch (err) {
      if (err instanceof AccessConflict) {
        // Someone saved first: what the server holds now replaces what is on screen, and the author applies their change again.
        try {
          await reload();
          setNotice(t(M['access.conflict']));
        } catch (reloadErr) {
          setError(problemText(reloadErr));
        }
      } else if (err instanceof AccessInvalid) {
        setError(t(M['access.refused'], { detail: err.fields.map((f) => `${f.path}: ${f.message}`).join('; ') || err.message }));
      } else {
        setError(problemText(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const setPassword = (password: string) =>
    run(async () => {
      await setFormPassword(org ?? '', formId, password);
      const next = { ...settings, hasPassword: true };
      setLoad((l) => (l.status === 'ready' ? { ...l, settings: { ...l.settings, hasPassword: true } } : l));
      rememberAccess(formId, next);
    });
  const removePassword = () =>
    run(async () => {
      await removeFormPassword(org ?? '', formId);
      const next = { ...settings, hasPassword: false };
      setLoad((l) => (l.status === 'ready' ? { ...l, settings: { ...l.settings, hasPassword: false } } : l));
      rememberAccess(formId, next);
    });

  const changed = isChanged(form, settings, zone);

  return (
    <section aria-label={t(M['access.title'])} className="space-y-4 border-t border-border/60 pt-4">
      {heading}
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="access-closed" className={labelCls}>{t(M['access.close_form'])}</Label>
        <Switch id="access-closed" checked={form.closed} onCheckedChange={(closed) => set({ closed })} />
      </div>
      {form.closed || form.closeAt !== '' || !isBlankDoc(form.closedMessage) ? (
        <div className="space-y-1.5">
          <Label className={labelCls}>{t(M['access.closed_message'])}</Label>
          <div className={cn('rounded-md border px-2', dark ? 'border-sidebar-border bg-sidebar-accent/40' : 'border-border')}>
            <RichEditor key={settings.rev} value={form.closedMessage} onChange={(closedMessage) => set({ closedMessage })} className="text-sm leading-6" placeholder={t(M['access.closed_message'])} />
          </div>
          <p className="text-[12px] text-muted-foreground">{t(M['access.closed_hint'])}</p>
        </div>
      ) : null}
      {dateField('openAt', t(M['access.open_at']))}
      {dateField('closeAt', t(M['access.close_at']))}
      <p className="text-[12px] text-muted-foreground">{t(M['access.zone_hint'], { zone })}</p>
      <WeeklyHours windows={form.windows} zone={form.windowZone} onChange={(windows) => set({ windows })} field={field} labelCls={labelCls} error={problem('windows')} />
      <div className="space-y-1.5">
        <Label htmlFor="access-limit" className={labelCls}>{t(M['access.limit'])}</Label>
        <Input id="access-limit" type="number" inputMode="numeric" min={1} className={field} value={form.limit} aria-invalid={problems.limit !== undefined} onChange={(e) => set({ limit: e.target.value })} />
        {problem('limit') ? <p className="text-[12px] text-destructive" role="alert">{problem('limit')}</p> : <p className="text-[12px] text-muted-foreground">{t(M['access.limit_hint'])}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="access-previous" className={labelCls}>{t(M['access.previous_hours'])}</Label>
        <Input id="access-previous" type="number" inputMode="numeric" min={0} max={720} className={field} value={form.previousHours} aria-invalid={problems.previousHours !== undefined} onChange={(e) => set({ previousHours: e.target.value })} />
        {problem('previousHours') ? <p className="text-[12px] text-destructive" role="alert">{problem('previousHours')}</p> : <p className="text-[12px] text-muted-foreground">{t(M['access.previous_hint'])}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="access-embed" className={labelCls}>{t(M['access.embed'])}</Label>
        <Textarea id="access-embed" rows={2} className={field} value={form.embed} placeholder="https://example.com" aria-invalid={problems.embed !== undefined} onChange={(e) => set({ embed: e.target.value })} />
        {problem('embed') ? <p className="text-[12px] text-destructive" role="alert">{problem('embed')}</p> : <p className="text-[12px] text-muted-foreground">{t(M['access.embed_hint'])}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="access-redirects" className={labelCls}>{t(M['access.redirects'])}</Label>
        <Textarea id="access-redirects" rows={2} className={field} value={form.redirects} placeholder="example.com" aria-invalid={problems.redirects !== undefined} onChange={(e) => set({ redirects: e.target.value })} />
        {problem('redirects') ? <p className="text-[12px] text-destructive" role="alert">{problem('redirects')}</p> : <p className="text-[12px] text-muted-foreground">{t(M['access.redirects_hint'])}</p>}
      </div>
      <div className="space-y-2">
        <Button type="button" size="sm" disabled={busy || !changed} onClick={() => void save()}>
          {t(M['access.save'])}
        </Button>
        {notice ? (
          <Alert variant="info" icon>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive" icon>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      <PasswordField hasPassword={settings.hasPassword} busy={busy} onSet={setPassword} onRemove={removePassword} field={field} labelCls={labelCls} />
      <AddressField
        key={slugs.slug ?? ''}
        slug={slugs.slug}
        previousSlugs={slugs.previousSlugs}
        busy={busy}
        field={field}
        labelCls={labelCls}
        onChange={async (slug) => {
          if (org === null) return { kind: 'error', message: t(M['access.sign_in']) };
          setBusy(true);
          try {
            const next = await changeSlug(org, formId, slug);
            setLoad((l) => (l.status === 'ready' ? { ...l, slugs: next } : l));
            return { kind: 'ok' };
          } catch (err) {
            if (err instanceof SlugTaken) return { kind: 'taken' };
            return { kind: 'error', message: err instanceof AccessInvalid ? err.fields.map((f) => f.message).join(' ') || err.message : problemText(err) };
          } finally {
            setBusy(false);
          }
        }}
      />
    </section>
  );
}
