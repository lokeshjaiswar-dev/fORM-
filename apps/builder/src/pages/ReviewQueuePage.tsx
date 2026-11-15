import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@dmacq/ui';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';

const M = defineMessages('builder', {
  'review_queue.title': 'Review queue',
  'review_queue.back': 'Back to forms',
  'review_queue.coming_soon': 'Responses that wait for your review will be listed here once approvals are set up for a form.',
});

/**
 * `/reviews`: the responses that wait for the signed-in member's review (WP-2.33). A placeholder until the reviewer's
 * page replaces this file; the route and the session gate are already in `App.tsx`.
 */
export function ReviewQueuePage() {
  return (
    <main className="mx-auto w-full max-w-[960px] px-8 pb-24 pt-8 text-foreground">
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-3">
        <Link to="/forms">
          <ArrowLeft />
          {t(M['review_queue.back'])}
        </Link>
      </Button>
      <h1 className="text-[28px] font-bold leading-[1.15] tracking-[-0.02em]">{t(M['review_queue.title'])}</h1>
      <p className="mt-3 text-[15px] leading-6 text-muted-foreground">{t(M['review_queue.coming_soon'])}</p>
    </main>
  );
}
