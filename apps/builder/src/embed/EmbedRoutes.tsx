import { Navigate, Route, Routes } from 'react-router-dom';
import { DmsMasterPage } from '@/embed/master/DmsMasterPage';
import DmsUploadPage from '@/embed/upload/DmsUploadPage';

/**
 * `/embed/*`: fORM- hosted inside another product (DMS+). These routes sit outside `RequireSession`: the host's own
 * session is what counts, not a fORM- account, and the persistence adapters never touch the fORM- API. Anything
 * that is not a known mode goes to the forms list like any other unknown address.
 */
export function EmbedRoutes() {
  return (
    <Routes>
      <Route path="dms-master" element={<DmsMasterPage />} />
      <Route path="dms-upload" element={<DmsUploadPage />} />
      <Route path="*" element={<Navigate to="/forms" replace />} />
    </Routes>
  );
}
