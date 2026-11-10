import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { loadSession } from '@/auth/client';
import { Toaster, TooltipProvider } from '@dmacq/ui';
import { BuilderPage } from '@/pages/BuilderPage';
import { PublicFillPage } from '@/pages/PublicFillPage';
import { FormsPage } from '@/pages/FormsPage';
import { ResponsesPage } from '@/pages/ResponsesPage';
import { MagicLinkPage, VerifyEmailPage } from '@/pages/auth/LinkPages';
import { MfaPage } from '@/pages/auth/MfaPage';
import { ForgotPasswordPage, ResetPasswordPage } from '@/pages/auth/PasswordPages';
import { SecurityPage } from '@/pages/auth/SecurityPage';
import { SignInPage } from '@/pages/auth/SignInPage';
import { SignUpPage } from '@/pages/auth/SignUpPage';
import { NoticePage } from '@/pages/privacy/NoticePage';
import { PrivacyPage } from '@/pages/privacy/PrivacyPage';
import { CreateOrgPage } from '@/pages/org/CreateOrgPage';
import { InvitePage } from '@/pages/org/InvitePage';
import { MembersPage } from '@/pages/org/MembersPage';
import { OrgSettingsPage } from '@/pages/org/OrgSettingsPage';
import { RepositoryProvider } from '@/persistence/RepositoryContext';
import { SubmissionsProvider } from '@/persistence/SubmissionsContext';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/f/:slug" element={<PublicFillPage />} />
      <Route path="/forms" element={<FormsPage />} />
      <Route path="/forms/:id/responses" element={<ResponsesPage />} />
      <Route path="/builder/:id/preview?" element={<BuilderPage />} />
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
  useEffect(() => {
    void loadSession();
  }, []);
  return (
    <RepositoryProvider>
      <SubmissionsProvider>
        <TooltipProvider>
          <BrowserRouter>
            <Toaster position="bottom-right" />
            <AppRoutes />
          </BrowserRouter>
        </TooltipProvider>
      </SubmissionsProvider>
    </RepositoryProvider>
  );
}
