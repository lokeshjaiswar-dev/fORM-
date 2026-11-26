import { Suspense, lazy } from 'react';
import UploadApp from './UploadApp';

/*
 * The one component behind `/embed/dms-upload` (the upload entry and the SPA route). Default build: fp-bridge/2 only (UploadApp).
 * The M2 legacy build (VITE_FP_LEGACY_DESCRIPTOR=1, SEC-DESIGN 3.5) also answers `fp_v=1` from the same-origin upload-v2 host on
 * LAN 105 with the retired /1 page. The constant below is folded at build time, so a default build contains no /1 code at all:
 * the dynamic import sits in a dead branch and its chunk is never emitted (checked by e2e/dms-upload.sandbox.spec.ts).
 */
const LegacyPage = import.meta.env.VITE_FP_LEGACY_DESCRIPTOR === '1' ? lazy(() => import('./legacy/DmsUploadPageV1')) : null;

export default function DmsUploadPage() {
  if (LegacyPage && new URLSearchParams(window.location.search).get('fp_v') === '1') {
    return (
      <Suspense fallback={null}>
        <LegacyPage />
      </Suspense>
    );
  }
  return <UploadApp />;
}
