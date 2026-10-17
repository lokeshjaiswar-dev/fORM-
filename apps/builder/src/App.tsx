import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { BuilderPage } from '@/pages/BuilderPage';

export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="bottom-right" />
      <Routes>
        <Route path="/" element={<Navigate to="/builder/demo" replace />} />
        <Route path="/builder" element={<Navigate to="/builder/demo" replace />} />
        <Route path="/builder/:id" element={<BuilderPage />} />
        <Route path="/builder/:id/preview" element={<BuilderPage />} />
      </Routes>
    </BrowserRouter>
  );
}
