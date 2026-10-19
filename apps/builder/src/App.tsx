import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { BuilderPage } from '@/pages/BuilderPage';
import { FormsPage } from '@/pages/FormsPage';
import { RepositoryProvider } from '@/persistence/RepositoryContext';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/forms" element={<FormsPage />} />
      <Route path="/builder/:id/preview?" element={<BuilderPage />} />
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
