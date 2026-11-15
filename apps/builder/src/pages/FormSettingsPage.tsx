import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@dmacq/ui';
import { defineMessages, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { EmailLogPanel } from '@/components/settings/EmailLogPanel';
import { NotificationsPanel } from '@/components/settings/NotificationsPanel';
import { WebhooksPanel } from '@/components/settings/WebhooksPanel';
import { builderPath } from '@/pages/useBuilderMode';
import { useRepository } from '@/persistence/repository';

const M = defineMessages('builder', {
  'form_settings.title': 'Form settings',
  'form_settings.back': 'Back to forms',
  'form_settings.open_form': 'Open form',
  'form_settings.untitled': 'Untitled form',
  'form_settings.sections': 'Settings sections',
  'form_settings.tab_emails': 'Emails',
  'form_settings.tab_webhooks': 'Webhooks',
  'form_settings.tab_email_log': 'Email log',
});

/** The tabs, as they appear in the address: `/forms/:id/settings/emails`. With no tab in the address the first one is shown. */
const TABS = ['emails', 'webhooks', 'email-log'] as const;
type Tab = (typeof TABS)[number];

const LABELS: Record<Tab, MessageId> = {
  emails: M['form_settings.tab_emails'],
  webhooks: M['form_settings.tab_webhooks'],
  'email-log': M['form_settings.tab_email_log'],
};

const settingsPath = (id: string, tab: Tab) => `/forms/${encodeURIComponent(id)}/settings/${tab}`;

const isTab = (value: string | undefined): value is Tab => TABS.some((tab) => tab === value);

function panelOf(tab: Tab, formId: string): ReactNode {
  switch (tab) {
    case 'emails':
      return <NotificationsPanel formId={formId} />;
    case 'webhooks':
      return <WebhooksPanel formId={formId} />;
    case 'email-log':
      return <EmailLogPanel formId={formId} />;
  }
}

/**
 * `/forms/:id/settings/:tab?`: what happens after a response is stored, one tab each: the emails sent (WP-1.16), the
 * webhooks called (WP-1.18) and the log of the emails. This page is the shell: the address names the tab, so a tab can be
 * linked to and Back moves between tabs, and each tab's content is its own panel under `components/settings/`. An address
 * that names no tab shows the first; one that names an unknown tab goes to the first.
 */
export function FormSettingsPage() {
  const { id = '', tab } = useParams();
  const forms = useRepository();
  const [title, setTitle] = useState<string | null>(null);

  // The title is the form's own, from this browser's copy of the drafts; the panels read what they need themselves.
  useEffect(() => {
    let live = true;
    const untitled = () => t(M['form_settings.untitled']);
    forms.load(id).then(
      (form) => {
        if (!live) return;
        const doc = form?.doc as { title?: unknown } | undefined;
        setTitle(typeof doc?.title === 'string' && doc.title.trim() ? doc.title.trim() : untitled());
      },
      () => live && setTitle(untitled()),
    );
    return () => {
      live = false;
    };
  }, [forms, id]);

  if (tab !== undefined && !isTab(tab)) return <Navigate to={settingsPath(id, 'emails')} replace />;
  const current: Tab = tab ?? 'emails';

  return (
    <main className="mx-auto w-full max-w-[960px] px-8 pb-24 pt-8 text-foreground">
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-3">
        <Link to="/forms">
          <ArrowLeft />
          {t(M['form_settings.back'])}
        </Link>
      </Button>
      <p className="text-[13px] font-medium uppercase tracking-[0.04em] text-muted-foreground">{t(M['form_settings.title'])}</p>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-[28px] font-bold leading-[1.15] tracking-[-0.02em]">{title ?? t(M['form_settings.title'])}</h1>
        {id ? (
          <Button variant="outline" size="sm" asChild>
            <Link to={builderPath(id)}>{t(M['form_settings.open_form'])}</Link>
          </Button>
        ) : null}
      </div>

      <nav aria-label={t(M['form_settings.sections'])} className="mt-6 flex gap-1 border-b border-border">
        {TABS.map((name) => {
          const selected = name === current;
          return (
            <Link
              key={name}
              to={settingsPath(id, name)}
              aria-current={selected ? 'page' : undefined}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-[14px] font-medium',
                selected ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t(LABELS[name])}
            </Link>
          );
        })}
      </nav>

      <section aria-label={t(LABELS[current])} className="pt-6">
        {panelOf(current, id)}
      </section>
    </main>
  );
}
