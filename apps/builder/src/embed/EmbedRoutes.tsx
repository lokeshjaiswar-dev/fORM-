import { Navigate, Route, Routes } from 'react-router-dom';
import { DmsMasterPage } from '@/embed/master/DmsMasterPage';
import { DmsRecordPage } from '@/embed/record/DmsRecordPage';
import { SessionGate } from '@/embed/session/SessionGate';

const framed = (): boolean => typeof window !== 'undefined' && window.parent !== window;

/** An unknown /embed path inside a frame: never navigate on to the full builder in a frame the host owns. */
function NotAvailableHere() {
  return (
    <main role="alert" style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      This page is not available here.
    </main>
  );
}

/**
 * `/embed/*`: fORM- hosted inside another product (DMS+). These routes sit outside `RequireSession`: DMS is the system of record, and
 * the persistence adapters never touch the fORM- API. `dms-master` and `dms-record` run inside `SessionGate`: DMS hands over a one-use
 * ticket in the URL fragment, the gate exchanges it for a short-lived session credential that lives only in memory
 * (session/dmsSession.ts), and the pages are rendered once DMS has said who the user is and what this page is for.
 *
 * `dms-upload` is not a route of this app: nginx serves its own entry (a sandboxed frame with no credential and no network, SEC-DESIGN
 * 3). A hit on it here, framed or not, is an unknown embed path.
 */
export function EmbedRoutes() {
  return (
    <Routes>
      <Route
        path="dms-master"
        element={
          <SessionGate mode="dms-master">
            <DmsMasterPage />
          </SessionGate>
        }
      />
      <Route
        path="dms-record"
        element={
          <SessionGate mode="dms-record">
            <DmsRecordPage />
          </SessionGate>
        }
      />
      <Route path="*" element={framed() ? <NotAvailableHere /> : <Navigate to="/forms" replace />} />
    </Routes>
  );
}
