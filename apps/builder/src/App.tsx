import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster, TooltipProvider } from '@dmacq/ui';
import { BuilderPage } from '@/pages/BuilderPage';
import { PublicFillPage } from '@/pages/PublicFillPage';
import { FormsPage } from '@/pages/FormsPage';
import { ResponsesPage } from '@/pages/ResponsesPage';
import { SharedPreviewPage } from '@/pages/SharedPreviewPage';
import { RepositoryProvider } from '@/persistence/RepositoryContext';
import { SubmissionsProvider } from '@/persistence/SubmissionsContext';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/f/:slug" element={<PublicFillPage />} />
      <Route path="/share" element={<SharedPreviewPage />} />
      <Route path="/forms" element={<FormsPage />} />
      <Route path="/forms/:id/responses" element={<ResponsesPage />} />
      <Route path="/fields/*" element={<Navigate to="/forms" replace />} />
      <Route path="/builder/:id/preview?" element={<BuilderPage />} />
      <Route path="*" element={<Navigate to="/forms" replace />} />
    </Routes>
  );
}

export default function App() {
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
