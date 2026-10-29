import { Link } from 'react-router-dom';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { Button } from '@/components/ui/button';
import { AuthLayout, FormError } from '../auth/AuthLayout';
import { PrivacyNotice } from './PrivacyNotice';
import { useNotice } from './useNotice';

const M = defineMessages('builder', {
  'notice_page.title': 'Privacy notice',
  'notice_page.loading': 'Loading the privacy notice…',
  'notice_page.failed': 'The privacy notice cannot be loaded right now.',
  'notice_page.retry': 'Try again',
  'notice_page.sign_up': 'Create an account',
  'notice_page.sign_in': 'Sign in',
});

/** `/privacy`: the platform privacy notice for anyone, linked from the sign-in and sign-up pages. */
export function NoticePage() {
  const { state, reload } = useNotice();
  const footer = (
    <span className="space-x-3">
      <Link to="/auth/sign-up" className="font-medium text-zinc-900 underline-offset-2 hover:underline">
        {t(M['notice_page.sign_up'])}
      </Link>
      <Link to="/auth/sign-in" className="font-medium text-zinc-900 underline-offset-2 hover:underline">
        {t(M['notice_page.sign_in'])}
      </Link>
    </span>
  );
  return (
    <AuthLayout wide title={state.status === 'ready' ? state.notice.title : t(M['notice_page.title'])} footer={footer}>
      {state.status === 'ready' ? (
        <PrivacyNotice notice={state.notice} />
      ) : state.status === 'failed' ? (
        <div className="space-y-3">
          <FormError message={t(M['notice_page.failed'])} />
          <Button variant="outline" onClick={reload}>
            {t(M['notice_page.retry'])}
          </Button>
        </div>
      ) : (
        <p className="text-[14px] text-[var(--notion-text-muted)]">{t(M['notice_page.loading'])}</p>
      )}
    </AuthLayout>
  );
}
