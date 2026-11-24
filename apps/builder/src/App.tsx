import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Button, Toaster, TooltipProvider } from '@dmacq/ui';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { AccountMenu } from '@/auth/AccountMenu';
import { activeOrgOf, loadSession, useSessionStore } from '@/auth/client';
import { rememberAfterSignIn } from '@/auth/returnTo';
import { BuilderPage } from '@/pages/BuilderPage';
import { PublicFillPage } from '@/pages/PublicFillPage';
import { FormSettingsPage } from '@/pages/FormSettingsPage';
import { FormsPage } from '@/pages/FormsPage';
import { ResponsesPage } from '@/pages/ResponsesPage';
import { ReviewQueuePage } from '@/pages/ReviewQueuePage';
import { MagicLinkPage, VerifyEmailPage } from '@/pages/auth/LinkPages';
import { MfaPage } from '@/pages/auth/MfaPage';
import { ForgotPasswordPage, ResetPasswordPage } from '@/pages/auth/PasswordPages';
import { SecurityPage } from '@/pages/auth/SecurityPage';
import { SignInPage } from '@/pages/auth/SignInPage';
import { SignUpPage } from '@/pages/auth/SignUpPage';
import { NoticePage } from '@/pages/privacy/NoticePage';
import { PrivacyPage } from '@/pages/privacy/PrivacyPage';
import { CreateOrgPage } from '@/pages/org/CreateOrgPage';
import { EmailSendersPage } from '@/pages/org/EmailSendersPage';
import { InvitePage } from '@/pages/org/InvitePage';
import { MembersPage } from '@/pages/org/MembersPage';
import { OrgSettingsPage } from '@/pages/org/OrgSettingsPage';
import { EmbedRoutes } from '@/embed/EmbedRoutes';
import { RepositoryProvider } from '@/persistence/RepositoryContext';
import { SubmissionsProvider } from '@/persistence/SubmissionsContext';

const M = defineMessages('builder', {
  'gate.unreachable_title': 'The server cannot be reached',
  'gate.unreachable_hint': 'Check your connection, then try again.',
  'gate.retry': 'Try again',
  'gate.no_org_title': 'Create an organisation to start',
  'gate.no_org_hint': 'Forms belong to an organisation. Create one to start building.',
  'gate.no_org_create': 'Set up your organisation',
});

/**
 * The forms list and the builder need a signed-in member of an org (BL-206): the drafts live on the server, in that
 * org. Someone who is signed out goes to sign in and comes back to this page afterwards. The respondent's page and the
 * account pages are outside this gate.
 */
function RequireSession({ children }: { children: ReactNode }) {
  const session = useSessionStore();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (session.status === 'unknown') void loadSession();
  }, [session.status]);

  useEffect(() => {
    if (session.status !== 'signed_out') return;
    rememberAfterSignIn(pathname);
    navigate('/auth/sign-in', { replace: true });
  }, [session.status, pathname, navigate]);

  if (session.status === 'signed_in') {
    if (activeOrgOf(session.me)) return <>{children}</>;
    return (
      <main className="mx-auto w-full max-w-[720px] px-8 pb-24 pt-[72px] text-foreground">
        <div className="-mt-12 mb-6 flex justify-end">
          <AccountMenu />
        </div>
        <h1 className="text-[28px] font-bold">{t(M['gate.no_org_title'])}</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">{t(M['gate.no_org_hint'])}</p>
        <Button className="mt-6" asChild>
          <Link to="/orgs/new">{t(M['gate.no_org_create'])}</Link>
        </Button>
      </main>
    );
  }
  if (session.status === 'unreachable') {
    return (
      <main className="mx-auto max-w-[720px] px-8 pt-[72px] text-foreground">
        <h1 className="text-[28px] font-bold">{t(M['gate.unreachable_title'])}</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">{t(M['gate.unreachable_hint'])}</p>
        <Button className="mt-6" onClick={() => void loadSession()}>
          {t(M['gate.retry'])}
        </Button>
      </main>
    );
  }
  return <main className="h-svh bg-background" aria-busy="true" />;
}

/** `VITE_BASE=/formplus/` serves the builder under a prefix (behind DMS's dev rewrite); the router follows it. */
const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/+$/, '');

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/f/:slug" element={<PublicFillPage />} />
      <Route path="/embed/*" element={<EmbedRoutes />} />
      <Route
        element={
          <RequireSession>
            <Outlet />
          </RequireSession>
        }
      >
        <Route path="/forms" element={<FormsPage />} />
        <Route path="/forms/:id/responses" element={<ResponsesPage />} />
        <Route path="/forms/:id/settings/:tab?" element={<FormSettingsPage />} />
        <Route path="/reviews" element={<ReviewQueuePage />} />
        <Route path="/org/email-senders" element={<EmailSendersPage />} />
        <Route path="/builder/:id/preview?" element={<BuilderPage />} />
      </Route>
      <Route path="/fields/*" element={<Navigate to="/forms" replace />} />
      <Route path="/auth/sign-in" element={<SignInPage />} />
      <Route path="/auth/sign-up" element={<SignUpPage />} />
      <Route path="/auth/verify" element={<VerifyEmailPage />} />
      <Route path="/auth/magic" element={<MagicLinkPage />} />
      <Route path="/auth/mfa" element={<MfaPage />} />
      <Route path="/auth/forgot" element={<ForgotPasswordPage />} />
      <Route path="/auth/reset" element={<ResetPasswordPage />} />
      <Route path="/account/security" element={<SecurityPage />} />
      <Route path="/account/privacy" element={<PrivacyPage />} />
      <Route path="/privacy" element={<NoticePage />} />
      <Route path="/orgs/new" element={<CreateOrgPage />} />
      <Route path="/org/members" element={<MembersPage />} />
      <Route path="/org/settings" element={<OrgSettingsPage />} />
      <Route path="/invite" element={<InvitePage />} />
      <Route path="*" element={<Navigate to="/forms" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <RepositoryProvider>
      <SubmissionsProvider>
        <TooltipProvider>
          <BrowserRouter basename={ROUTER_BASENAME}>
            <Toaster position="bottom-right" />
            <AppRoutes />
          </BrowserRouter>
        </TooltipProvider>
      </SubmissionsProvider>
    </RepositoryProvider>
  );
}
