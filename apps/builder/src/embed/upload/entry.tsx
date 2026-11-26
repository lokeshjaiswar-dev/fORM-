import './jitless';
import './upload.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import DmsUploadPage from './DmsUploadPage';

/*
 * The own entry of `/formplus/embed/dms-upload` (SEC-DESIGN 3.3 B1, `embed-upload.html`). It runs in an opaque origin: no cookie,
 * no web storage, no IndexedDB, no network, no history API, no router. It imports only embed/upload, embed/bridge, embed/lookup,
 * embed/contract, the renderer and the profile packages; `.dependency-cruiser.cjs` (rule `upload-entry-isolated`) keeps the storage-
 * touching builder modules (edition, auth/returnTo, org/pendingInvite, persistence, design/uploads) out of its reach, and
 * e2e/dms-upload.sandbox.spec.ts runs the built page with those APIs blocked and fails on any console error.
 */

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DmsUploadPage />
  </StrictMode>,
);
