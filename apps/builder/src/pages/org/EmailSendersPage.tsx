import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@dmacq/ui';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';

const M = defineMessages('builder', {
  'email_senders.title': 'Email senders',
  'email_senders.back': 'Back to organisation settings',
  'email_senders.coming_soon': 'The addresses your organisation sends form emails from will be set up here.',
});

/**
 * `/org/email-senders`: the org's email senders, the "from" addresses of form notifications (WP-1.16). A placeholder until
 * the notifications UI replaces this file; the route and the session gate are already in `App.tsx`.
 */
export function EmailSendersPage() {
  return (
    <main className="mx-auto w-full max-w-[720px] px-8 pb-24 pt-8 text-foreground">
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-3">
        <Link to="/org/settings">
          <ArrowLeft />
          {t(M['email_senders.back'])}
        </Link>
      </Button>
      <h1 className="text-[28px] font-bold leading-[1.15] tracking-[-0.02em]">{t(M['email_senders.title'])}</h1>
      <p className="mt-3 text-[15px] leading-6 text-muted-foreground">{t(M['email_senders.coming_soon'])}</p>
    </main>
  );
}
