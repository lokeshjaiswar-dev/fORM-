import { Button } from '@dmacq/ui';
import { dismissReconnect, type SessionSnapshot } from './dmsSession';
import type { HandoffEnv } from './handoff';
import type { ReconnectDeps } from './reconnect';
import { usePreparedReconnect, type Prepared } from './usePreparedReconnect';

/*
 * The Reconnect prompt (SEC-DESIGN 1.7): a banner over the KEPT page when the session is invalid or about to expire, and the button
 * of the "Session ended" screen after a reload. It prepares the reconnect (verifier and challenge, in memory) as soon as it shows, so
 * the click itself can open the DMS tab synchronously (a popup blocker only allows `window.open` from the gesture).
 */

const STATUS_TEXT = {
  waiting: 'Finish in the DMS tab that just opened. This page continues by itself.',
  exchanging: 'Reconnecting...',
  failed: 'Reconnecting did not work. Try again.',
  unavailable: 'This page cannot reconnect from here. Go back to DMS and open the form again.',
} as const;

/** The button and its status line, shared by the banner and the "Session ended" screen. */
export function ReconnectButton({ snap, prepared }: { snap: SessionSnapshot; prepared: Prepared }) {
  const busy = snap.reconnect === 'exchanging';
  const status = prepared.state === 'unavailable' ? STATUS_TEXT.unavailable : snap.reconnect === 'idle' ? null : STATUS_TEXT[snap.reconnect];
  return (
    <>
      {prepared.state !== 'unavailable' ? (
        <Button type="button" size="sm" data-testid="fp-reconnect-button" disabled={prepared.state !== 'ready' || busy} onClick={() => (prepared.state === 'ready' ? prepared.handle.open() : undefined)}>
          {snap.reconnect === 'failed' ? 'Try again' : 'Reconnect to DMS'}
        </Button>
      ) : null}
      {status ? (
        <span role="status" className="text-[13px]" data-testid="fp-reconnect-status">
          {status}
        </span>
      ) : null}
    </>
  );
}

/** Over the kept page: the session is invalid or about to expire. The page and its unsaved state stay exactly as they are. */
export function ReconnectBanner({ snap, env, deps }: { snap: SessionSnapshot; env: HandoffEnv; deps?: ReconnectDeps }) {
  const prepared = usePreparedReconnect(snap, env, true, deps);
  const expiring = snap.phase === 'expiring';
  return (
    <div role="alert" data-testid="fp-reconnect-banner" className="fixed inset-x-0 top-0 z-[100] flex flex-wrap items-center gap-3 border-b border-border bg-background px-4 py-3 text-[14px] text-foreground shadow-md">
      <p className="min-w-0 flex-1">
        {expiring ? 'Your DMS session ends in a few minutes. Reconnect to DMS to keep working.' : 'Your DMS session has ended. Reconnect to DMS to continue; what you entered on this page is kept.'}
      </p>
      <ReconnectButton snap={snap} prepared={prepared} />
      <Button type="button" size="sm" variant="ghost" data-testid="fp-reconnect-dismiss" onClick={dismissReconnect}>
        Not now
      </Button>
    </div>
  );
}
