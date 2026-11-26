import type { LaunchMode, LegacyFailure } from './launchTypes';
import { readHandoffEnv } from './env';
import { takeHandoff, type HandoffEnv, type HandoffFailure, type ResumeHint } from './handoff';
import { enterResume, exchangeTicket, ExchangeError, installSession, memoLaunch, replaceLaunchMemo, type ExchangeFailure } from './dmsSession';

/*
 * One page view's launch, start to finish: read the hand-off (fragment stripped first), exchange the ticket, install the session.
 * `SessionGate` renders from the result; `launch.ts` and `dmsClient.ts` read the installed session. Memoised per page view and mode
 * so a StrictMode remount does not run it twice (the second run would find the fragment and the verifier already consumed).
 */

export type LaunchFailureReason = HandoffFailure | ExchangeFailure | LegacyFailure;

export type LaunchOutcome =
  /** A session is installed; the page can render. */
  | { kind: 'session' }
  /** The M2 legacy build accepted a `#fp=` launch. */
  | { kind: 'legacy' }
  /** A reload: no credential, a Reconnect offer from the non-secret hint. No request was made. */
  | { kind: 'resume'; hint: ResumeHint }
  /** No context: the page shows "Go back to DMS and open the form again". `retry` exists for a transient failure (store down, offline). */
  | { kind: 'failed'; reason: LaunchFailureReason; retry?: () => Promise<LaunchOutcome> };

export interface LaunchDeps {
  env?: HandoffEnv;
  /** For tests; defaults to `window.fetch`. */
  fetch?: typeof fetch;
  loc?: Pick<Location, 'hash' | 'pathname' | 'search'>;
}

async function exchangeAndInstall(mode: LaunchMode, ticket: { ticket: string; verifier: string; apiBase: string }, env: HandoffEnv, deps: LaunchDeps): Promise<LaunchOutcome> {
  try {
    const response = await exchangeTicket({ apiBase: ticket.apiBase, ticket: ticket.ticket, verifier: ticket.verifier, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    // A ticket for another screen (a dms-record link on the dms-master route): the credential is dropped without being stored.
    if (response.context.mode !== mode) return { kind: 'failed', reason: 'wrong_mode' };
    installSession(response, ticket.apiBase, env, deps.fetch);
    return { kind: 'session' };
  } catch (e) {
    const reason: LaunchFailureReason = e instanceof ExchangeError ? e.reason : 'unreachable';
    // Only a failure before the ticket was spent can be tried again with the same ticket and verifier, which this closure still holds.
    const transient = reason === 'unavailable' || reason === 'unreachable';
    return transient ? { kind: 'failed', reason, retry: () => exchangeAndInstall(mode, ticket, env, deps) } : { kind: 'failed', reason };
  }
}

async function run(mode: LaunchMode, deps: LaunchDeps): Promise<LaunchOutcome> {
  const env = deps.env ?? readHandoffEnv();
  const handoff = deps.loc ? takeHandoff(env, deps.loc) : takeHandoff(env);
  switch (handoff.kind) {
    case 'ticket':
      return exchangeAndInstall(mode, handoff, env, deps);
    case 'resume':
      if (handoff.hint.mode !== mode) return { kind: 'failed', reason: 'wrong_mode' };
      enterResume(handoff.hint);
      return { kind: 'resume', hint: handoff.hint };
    case 'legacy':
      // The M2 build only. The literal comparison is what lets the bundler drop this branch, and the legacy modules with it, from a default build.
      if (import.meta.env.VITE_FP_LEGACY_DESCRIPTOR === '1') {
        const legacy = await import('@/embed/legacy');
        return await legacy.startLegacyLaunch(mode, handoff.fragment, env);
      }
      return { kind: 'failed', reason: 'legacy_descriptor' };
    case 'failed':
      if (handoff.reason === 'missing' && import.meta.env.VITE_FP_LEGACY_DESCRIPTOR === '1') {
        const legacy = await import('@/embed/legacy');
        const kept = await legacy.resumeLegacyLaunch(mode, env);
        if (kept) return kept;
      }
      return { kind: 'failed', reason: handoff.reason };
  }
}

/** A retried launch replaces the failed one in the memo, so a remount after a successful retry does not show the old failure. */
function remembered(mode: LaunchMode, outcome: LaunchOutcome): LaunchOutcome {
  if (outcome.kind !== 'failed' || outcome.retry === undefined) return outcome;
  const retry = outcome.retry;
  return {
    ...outcome,
    retry: async () => {
      const next = remembered(mode, await retry());
      replaceLaunchMemo(mode, next);
      return next;
    },
  };
}

/** Runs (once per page view and mode) the launch this page view was opened with. */
export function startLaunch(mode: LaunchMode, deps: LaunchDeps = {}): Promise<LaunchOutcome> {
  return memoLaunch(mode, async () => remembered(mode, await run(mode, deps)));
}
