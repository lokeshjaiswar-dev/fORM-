import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@dmacq/ui';
import type { TicketMode } from '@/embed/contract';
import { sessionSnapshot, subscribeSession, type SessionSnapshot } from './dmsSession';
import { readHandoffEnv } from './env';
import { allowedUrl, type HandoffEnv } from './handoff';
import { startLaunch, type LaunchDeps, type LaunchFailureReason, type LaunchOutcome } from './launchFlow';
import type { ReconnectDeps } from './reconnect';
import { ReconnectBanner, ReconnectButton } from './Reconnect';
import { usePreparedReconnect } from './usePreparedReconnect';

/*
 * Wraps `dms-master` and `dms-record` (EmbedRoutes). It runs the launch (fragment stripped, ticket exchanged for the in-memory
 * credential), and renders the page only once DMS has said who the user is and what this page is for. The pages themselves know
 * nothing of the session: they call `currentLaunch(mode)` and `createDmsClient(...)` as before.
 *
 *   no context     "Go back to DMS and open the form again" (history.back()), or "no longer supported" for a `#fp=` link
 *   reload         "Session ended" and a Reconnect button, no API call (SEC 1.7)
 *   401 mid-work   the Reconnect banner over the KEPT page; the failed request resumes after a successful reconnect
 *   other identity "You are signed in as someone else": the page is blocked, the new credential was never stored
 */

export interface SessionGateProps {
  mode: TicketMode;
  children: ReactNode;
  /** For tests: the build environment, `fetch`, the location, and the reconnect doubles. */
  deps?: LaunchDeps & { reconnect?: ReconnectDeps };
}

function Message({ title, testId, children }: { title: string; testId?: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-[720px] px-8 pt-[72px] text-foreground" {...(testId ? { 'data-testid': testId } : {})}>
      <h1 className="text-[28px] font-bold">{title}</h1>
      <div className="mt-2 space-y-4 text-[15px] text-muted-foreground">{children}</div>
    </main>
  );
}

const NOT_FROM_DMS = 'Open this page from DMS. It starts with the master you chose and cannot be opened on its own.';
const BASE_REJECTED = 'This launch link points at a DMS server this page is not set up to talk to, so nothing was sent to it.';

/** No context was obtained (SEC 1.11): the ticket is spent, expired, or was never meant for this tab. Nothing was changed. */
function LaunchFailed({ reason, retry }: { reason: LaunchFailureReason; retry: (() => void) | undefined }) {
  if (reason === 'missing') {
    return (
      <Message title="This page was not opened from DMS" testId="fp-launch-failed">
        <p>{NOT_FROM_DMS}</p>
      </Message>
    );
  }
  if (reason === 'legacy_descriptor') {
    return (
      <Message title="This page was not opened from DMS" testId="fp-launch-failed">
        <p>This link is no longer supported. Open the form again from DMS.</p>
      </Message>
    );
  }
  if (reason === 'api_not_allowed') {
    return (
      <Message title="This page was not opened from DMS" testId="fp-launch-failed">
        <p>{BASE_REJECTED}</p>
      </Message>
    );
  }
  if (reason === 'unavailable' || reason === 'unreachable') {
    return (
      <Message title="Forms+ is temporarily unavailable" testId="fp-launch-failed">
        <p>Forms+ is temporarily unavailable, try again.</p>
        {retry ? <Button onClick={retry}>Try again</Button> : null}
      </Message>
    );
  }
  return (
    <Message title="Go back to DMS and open the form again" testId="fp-launch-failed">
      <p>This launch link was already used, has expired, or was opened in another tab, so no session was started. Nothing was changed.</p>
      <Button onClick={() => window.history.back()}>Go back to DMS</Button>
    </Message>
  );
}

function BackLink({ snap, env }: { snap: SessionSnapshot; env: HandoffEnv }) {
  const url = allowedUrl(snap.context?.return_url ?? snap.resume?.return_url, env);
  return url ? (
    <p>
      <a className="underline" href={url}>
        Back to DMS
      </a>
    </p>
  ) : null;
}

/** Reload: the credential is gone with the page. */
function SessionEnded({ snap, env, reconnect }: { snap: SessionSnapshot; env: HandoffEnv; reconnect: ReconnectDeps | undefined }) {
  const prepared = usePreparedReconnect(snap, env, true, reconnect);
  return (
    <Message title="Session ended" testId="fp-session-ended">
      <p>Your DMS session ended when this page was reloaded or left, and changes that were not saved are gone. Reconnect to DMS to open the form again.</p>
      <div className="flex flex-wrap items-center gap-3">
        <ReconnectButton snap={snap} prepared={prepared} />
      </div>
      <BackLink snap={snap} env={env} />
    </Message>
  );
}

/** A reconnect came back as another user, workspace or master (SEC 1.7): nothing may continue on this page. */
function SignedInElsewhere({ snap, env }: { snap: SessionSnapshot; env: HandoffEnv }) {
  return (
    <Message title="You are signed in as someone else" testId="fp-signed-in-elsewhere">
      <p>DMS now has a different user, workspace or item open than the one this page was started for. The new session was discarded and nothing was sent. Go back to DMS and open the form again.</p>
      <BackLink snap={snap} env={env} />
      <Button onClick={() => window.history.back()}>Go back</Button>
    </Message>
  );
}

export function SessionGate({ mode, children, deps }: SessionGateProps) {
  const [outcome, setOutcome] = useState<LaunchOutcome | null>(null);
  const snap = useSyncExternalStore(subscribeSession, sessionSnapshot, sessionSnapshot);
  const env = useMemo(() => deps?.env ?? readHandoffEnv(), [deps?.env]);

  useEffect(() => {
    let live = true;
    void startLaunch(mode, deps).then((o) => live && setOutcome(o));
    return () => {
      live = false;
    };
    // The launch runs once per page view (memoised); `deps` is a test hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  if (outcome === null) return <main className="h-svh bg-background" aria-busy="true" data-testid="fp-session-loading" />;
  if (outcome.kind === 'failed') {
    const retry = outcome.retry;
    return <LaunchFailed reason={outcome.reason} retry={retry ? () => void retry().then(setOutcome) : undefined} />;
  }
  if (snap.phase === 'mismatch') return <SignedInElsewhere snap={snap} env={env} />;
  if (outcome.kind === 'legacy') return <>{children}</>;
  if (snap.context === null) {
    return snap.phase === 'ended' ? <SessionEnded snap={snap} env={env} reconnect={deps?.reconnect} /> : <main className="h-svh bg-background" aria-busy="true" data-testid="fp-session-loading" />;
  }
  const prompt = (snap.phase === 'invalid' || snap.phase === 'expiring' || snap.phase === 'ended') && !snap.dismissed;
  return (
    <>
      {prompt ? <ReconnectBanner snap={snap} env={env} {...(deps?.reconnect ? { deps: deps.reconnect } : {})} /> : null}
      {children}
    </>
  );
}
