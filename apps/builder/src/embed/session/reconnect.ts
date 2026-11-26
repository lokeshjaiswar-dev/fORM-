import { TICKET_RE, type ExchangeResponse, type SessionContext, type TicketMode } from '@/embed/contract';
import { allowedUrl, type HandoffEnv } from './handoff';
import { exchangeTicket, internalBlockMismatch, internalReplaceCredential, internalSetReconnect } from './dmsSession';
import { challengeOf, newVerifier } from './pkce';

/*
 * State-preserving reconnect (SEC-DESIGN 1.7). When the session is gone (401 FP_SESSION_INVALID) or about to be (5 minutes before the
 * absolute expiry), the page is KEPT and the user clicks "Reconnect to DMS":
 *
 *   1. a fresh PKCE verifier is made IN MEMORY (never storage) and its S256 challenge;
 *   2. the click opens `reconnect_url#c=<challenge>&mode=..&master_id=..&record_id=..` in a new tab (a user gesture, so `open()` is
 *      synchronous and the challenge is prepared before the click);
 *   3. the DMS reconnect page asks dms-api for a ticket bound to that challenge and broadcasts `{challenge, ticket}` on
 *      `BroadcastChannel('fp-reconnect')` (not `window.opener`: fORM- sends `Cross-Origin-Opener-Policy: same-origin`, which severs it);
 *   4. this page listens for ITS OWN challenge only, exchanges the ticket with the in-memory verifier, and compares the new context with
 *      the page's: any difference blocks with "You are signed in as someone else" and the new credential is discarded, never stored.
 *
 * The channel needs no secrecy: a ticket is useless without the verifier, which never leaves this module.
 */

export const RECONNECT_CHANNEL = 'fp-reconnect';

/** The slice of `BroadcastChannel` this module uses (also what tests double). */
export interface ChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface ReconnectDeps {
  /** For tests; defaults to `window.fetch`. */
  fetch?: typeof fetch;
  /** For tests; defaults to `window.open(url, '_blank', 'noopener')`. */
  openWindow?: (url: string) => void;
  /** For tests; defaults to `new BroadcastChannel(name)`, or null when the browser has none. */
  createChannel?: (name: string) => ChannelLike | null;
}

/** What the reconnect is for. `apiBase` is the allowlisted base the exchange goes to. */
export interface ReconnectTarget {
  mode: TicketMode;
  masterId: string | null;
  recordId: string | null;
  reconnectUrl: string;
  apiBase: string;
}

/** The identity the new context must equal. Fields a reload does not know (tenant, workspace, user) are left out and not compared. */
export interface ExpectedIdentity {
  mode: TicketMode;
  master_id: string | null;
  record_id: string | null;
  tenant_id?: string;
  workspace_id?: string;
  user_id?: string;
}

/** The comparison of SEC 1.7: tenant, workspace, user, mode, master and record. */
export function sameIdentity(context: SessionContext, expected: ExpectedIdentity): boolean {
  return (
    context.mode === expected.mode &&
    context.master_id === expected.master_id &&
    context.record_id === expected.record_id &&
    (expected.tenant_id === undefined || context.tenant_id === expected.tenant_id) &&
    (expected.workspace_id === undefined || context.workspace_id === expected.workspace_id) &&
    (expected.user_id === undefined || context.user.id === expected.user_id)
  );
}

/** The browser cannot reconnect (no BroadcastChannel, or the reconnect URL is not on the allowlist). The page says to go back to DMS. */
export class ReconnectUnavailableError extends Error {
  constructor() {
    super('This page cannot reconnect to DMS from here.');
    this.name = 'ReconnectUnavailableError';
  }
}

export interface ReconnectHandle {
  /** The S256 challenge this reconnect listens for. */
  readonly challenge: string;
  /** Opens the DMS reconnect tab. Call it from the click handler itself (synchronously), or a popup blocker may refuse it. */
  open(): void;
  /** Stops listening. The verifier is dropped with the handle. */
  cancel(): void;
}

let active: ReconnectHandle | null = null;

/** The URL of the DMS reconnect tab: `reconnect_url` with a fresh fragment that names the challenge and what to reconnect to. */
export function reconnectTabUrl(reconnectUrl: string, challenge: string, target: Pick<ReconnectTarget, 'mode' | 'masterId' | 'recordId'>): string {
  const url = new URL(reconnectUrl);
  const params = new URLSearchParams({ c: challenge, mode: target.mode });
  if (target.masterId !== null) params.set('master_id', target.masterId);
  if (target.recordId !== null) params.set('record_id', target.recordId);
  url.hash = params.toString();
  return url.toString();
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const defaultChannel = (name: string): ChannelLike | null => (typeof BroadcastChannel === 'undefined' ? null : (new BroadcastChannel(name) as unknown as ChannelLike));
/** `noopener`: the DMS tab answers on the BroadcastChannel and never needs (or gets) a handle on this page. */
const defaultOpen = (url: string): void => {
  window.open(url, '_blank', 'noopener');
};

/**
 * Prepares a reconnect: verifier, challenge and the channel. Nothing is shown to DMS until `open()`. A second call cancels the first.
 * Throws `ReconnectUnavailableError` when the URL is not allowlisted or the browser has no `BroadcastChannel`.
 */
export async function prepareReconnect(target: ReconnectTarget, expected: ExpectedIdentity, env: HandoffEnv, deps: ReconnectDeps = {}): Promise<ReconnectHandle> {
  active?.cancel();
  const reconnectUrl = allowedUrl(target.reconnectUrl, env);
  const channel = (deps.createChannel ?? defaultChannel)(RECONNECT_CHANNEL);
  if (reconnectUrl === null || channel === null) {
    channel?.close();
    throw new ReconnectUnavailableError();
  }
  const verifier = newVerifier();
  const challenge = await challengeOf(verifier);
  let finished = false;

  const finish = (): void => {
    finished = true;
    channel.onmessage = null;
    channel.close();
    if (active === handle) active = null;
  };

  const complete = async (ticket: string): Promise<void> => {
    internalSetReconnect('exchanging');
    let response: ExchangeResponse;
    try {
      response = await exchangeTicket({ apiBase: target.apiBase, ticket, verifier, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    } catch {
      internalSetReconnect('failed');
      return finish();
    }
    if (!sameIdentity(response.context, expected)) {
      // Someone else (another user, workspace or master) is signed in to DMS now: the credential is dropped without ever being stored.
      internalBlockMismatch();
      return finish();
    }
    internalReplaceCredential(response, env, target.apiBase, deps.fetch);
    finish();
  };

  channel.onmessage = (event) => {
    if (finished) return;
    const data = event.data;
    // Other tabs reconnect too: only a message for OUR challenge counts, with exactly the two expected keys.
    if (!isRecord(data) || data.challenge !== challenge) return;
    const keys = Object.keys(data);
    if (keys.length !== 2 || !keys.includes('ticket') || typeof data.ticket !== 'string' || !TICKET_RE.test(data.ticket)) return;
    finished = true;
    void complete(data.ticket);
  };

  const handle: ReconnectHandle = {
    challenge,
    open() {
      (deps.openWindow ?? defaultOpen)(reconnectTabUrl(reconnectUrl, challenge, target));
      internalSetReconnect('waiting');
    },
    cancel() {
      if (!finished) internalSetReconnect('idle');
      finish();
    },
  };
  active = handle;
  return handle;
}

/** For tests. */
export function resetReconnectForTests(): void {
  active?.cancel();
  active = null;
}
