import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { BuilderPage } from '@/pages/BuilderPage';
import { FormsPage } from '@/pages/FormsPage';
import { MagicLinkPage, VerifyEmailPage } from '@/pages/auth/LinkPages';
import { MfaPage } from '@/pages/auth/MfaPage';
import { ForgotPasswordPage, ResetPasswordPage } from '@/pages/auth/PasswordPages';
import { SecurityPage } from '@/pages/auth/SecurityPage';
import { SignInPage } from '@/pages/auth/SignInPage';
import { SignUpPage } from '@/pages/auth/SignUpPage';
import { NoticePage } from '@/pages/privacy/NoticePage';
import { PrivacyPage } from '@/pages/privacy/PrivacyPage';
import { RepositoryProvider } from '@/persistence/RepositoryContext';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/forms" element={<FormsPage />} />
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
      <Route path="*" element={<Navigate to="/forms" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <RepositoryProvider>
      <BrowserRouter>
        <Toaster position="bottom-right" />
        <AppRoutes />
      </BrowserRouter>
    </RepositoryProvider>
  );
}
