import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BrowserContext, Page, Route } from '@playwright/test';

/*
 * The DMS side of the ticket launch, stubbed for the fORM- e2e suite (DESIGN 3.2, SEC-DESIGN 1.3-1.7). The real stack is the final e2e;
 * here a route stub plays dms-api and the DMS page:
 *
 *   - `issue()` is what `POST launch-tickets` does: it stores a ticket with the PKCE challenge of a verifier;
 *   - `launch()` is the DMS page: it leaves the verifier in `sessionStorage['fp.lv']` of the tab (only when the fragment carries this
 *     ticket) and navigates to `/embed/<mode>#fpt=<ticket>`;
 *   - the exchange route checks S256(verifier) against the stored challenge, burns the ticket, and answers with a credential and context;
 *   - every `/dms/v1/formplus/s/*` route checks the bearer, answers 401 `FP_SESSION_INVALID` for an expired one, and refuses (404) a
 *     request carrying `X-Tenant-Id`/`X-Workspace-Id` the way `fp.resolve:session` would answer a different context;
 *   - `/dms-reconnect` is the DMS reconnect page: it asks this stub for a ticket bound to the challenge in its fragment and broadcasts
 *     `{challenge, ticket}` on `BroadcastChannel('fp-reconnect')`, then closes itself.
 *
 * Routes are installed on the browser CONTEXT so the reconnect tab the Reconnect button opens is served by the same stub.
 */

export const ORIGIN = 'http://localhost:4173';
export const API = `${ORIGIN}/api`;
export const RETURN = `${ORIGIN}/dms-return`;
export const RECONNECT = `${ORIGIN}/dms-reconnect`;
export const SESSION_PREFIX = '/api/dms/v1/formplus/s';
export const EXCHANGE_PATH = '/api/dms/v1/formplus/launch-tickets/exchange';

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const WORKSPACE = '0a000000-0000-4000-8000-000000000001';
export const USER_A = { id: 'b0000000-0000-4000-8000-000000000001', name: 'Asha Editor' };
export const USER_B = { id: 'b0000000-0000-4000-8000-0000000000bb', name: 'Bela Someone-Else' };

const b64url = (b: Buffer) => b.toString('base64url');
export const s256 = (verifier: string) => b64url(createHash('sha256').update(verifier, 'ascii').digest());

export interface IssueOptions {
  mode: 'dms-master' | 'dms-record';
  masterId?: string | null;
  recordId?: string | null;
  seed?: { name: string; doctype_ids: readonly string[]; folder_ids: readonly string[]; classification: 'public' | 'confidential' | 'restricted' | null } | null;
  user?: { id: string; name: string };
  /** Seconds, as the exchange reports them. */
  absoluteExpiresIn?: number;
}

export interface Issued {
  ticket: string;
  verifier: string;
  challenge: string;
  mode: IssueOptions['mode'];
}

export interface Recorded {
  method: string;
  /** Path and query, as sent (`/api/dms/...`). */
  path: string;
  headers: Record<string, string>;
  body: unknown;
  status: number;
}

export interface SessionRequest {
  method: string;
  /** The route below `/api/dms/v1/formplus/s`, with the query: `master/form`, `master-records/<id>?master_id=...`. */
  route: string;
  /** The same route under its legacy name (what the fixtures are written in): `/dms/v1/master/form`, `/dms/master-records/<id>?...`. */
  legacy: string;
  body: unknown;
  headers: Record<string, string>;
}

export type SessionAnswer = { status: number; body: unknown } | null;

export interface StubOptions {
  /** What dms-api answers on a session route once the bearer checked out. `null`/undefined = 404. */
  answer?: (req: SessionRequest) => SessionAnswer | undefined;
  /** The page that stands for the DMS return URL. */
  returnHtml?: string;
}

interface TicketState {
  challenge: string;
  options: IssueOptions;
  used: boolean;
}

export class DmsStub {
  /** Everything fORM- sent under `/api/`. */
  readonly requests: Recorded[] = [];
  readonly exchanges: Array<{ ticket: string; ok: boolean; hadAuthorization: boolean }> = [];
  /** Problems the stub itself noticed (a tenant header, a credential on the wrong route, ...). Must stay empty. */
  readonly violations: string[] = [];
  /** Credentials minted by the exchange, oldest first, with the identity they belong to. */
  readonly credentials: Array<{ credential: string; userId: string; mode: string }> = [];
  private readonly tickets = new Map<string, TicketState>();
  private readonly expired = new Set<string>();
  private reconnectUser: { id: string; name: string } | null = null;
  private lastIssue: IssueOptions | null = null;

  private readonly options: StubOptions;

  constructor(options: StubOptions = {}) {
    this.options = options;
  }

  /** What `POST launch-tickets` stores: a ticket bound to the challenge of a fresh verifier. */
  issue(options: IssueOptions): Issued {
    const ticket = `fpt1_${b64url(randomBytes(32))}`;
    const verifier = b64url(randomBytes(32));
    const challenge = s256(verifier);
    this.tickets.set(ticket, { challenge, options, used: false });
    this.lastIssue = options;
    return { ticket, verifier, challenge, mode: options.mode };
  }

  /** The reconnect page asks for a ticket bound to a challenge it was given (it never sees the verifier). */
  private issueForChallenge(challenge: string, mode: string): string {
    const base = this.lastIssue ?? { mode: mode as IssueOptions['mode'] };
    const options: IssueOptions = { ...base, ...(this.reconnectUser ? { user: this.reconnectUser } : {}) };
    const ticket = `fpt1_${b64url(randomBytes(32))}`;
    this.tickets.set(ticket, { challenge, options, used: false });
    return ticket;
  }

  /** The next reconnect comes back as another user (SEC 1.7: the page must block). */
  reconnectAs(user: { id: string; name: string } | null): void {
    this.reconnectUser = user;
  }

  /** From now on every credential minted so far answers 401 `FP_SESSION_INVALID` (idle or absolute expiry). */
  expireAll(): void {
    for (const c of this.credentials) this.expired.add(c.credential);
  }

  /** The requests under the session group, in order. */
  sessionRequests(): Recorded[] {
    return this.requests.filter((r) => r.path.startsWith(SESSION_PREFIX));
  }

  /** Every string a request could carry a secret in, joined: URL, headers, body. */
  haystack(): string {
    return JSON.stringify(this.requests.map((r) => [r.path, r.headers, r.body]));
  }

  /** Wires the routes on the context (so a reconnect tab shares them). */
  async install(context: BrowserContext): Promise<void> {
    await context.route('**/api/dms/**', (route) => this.api(route));
    await context.route('**/dms-return**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: this.options.returnHtml ?? '<title>DMS</title><p>back in DMS</p>' }));
    await context.route('**/dms-reconnect**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: RECONNECT_PAGE }));
    await context.route('**/__stub/reconnect-ticket', async (route) => {
      const body = route.request().postDataJSON() as { challenge: string; mode: string };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: this.issueForChallenge(body.challenge, body.mode) }) });
    });
  }

  private async api(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = `${url.pathname}${url.search}`;
    // allHeaders (not headers): a cookie the browser attached would only show here.
    const headers = await request.allHeaders();
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData();
    }
    const record = (status: number) => this.requests.push({ method: request.method(), path, headers, body, status });
    const err = (status: number, code: string, message: string) => ({ status, body: { success: false, code, message, request_id: headers['x-request-id'] ?? null } });

    if (url.pathname === EXCHANGE_PATH) {
      const payload = (body ?? {}) as { ticket?: string; verifier?: string };
      const state = payload.ticket ? this.tickets.get(payload.ticket) : undefined;
      const hadAuthorization = 'authorization' in headers;
      if (hadAuthorization) this.violations.push('the exchange carried an Authorization header');
      const good = state !== undefined && !state.used && typeof payload.verifier === 'string' && s256(payload.verifier) === state.challenge;
      this.exchanges.push({ ticket: payload.ticket ?? '', ok: good, hadAuthorization });
      if (!good || state === undefined) {
        record(401);
        return json(401, err(401, 'FP_TICKET_INVALID', 'The launch link is not valid.').body);
      }
      state.used = true;
      const o = state.options;
      const credential = `fps1_${b64url(randomBytes(32))}`;
      const user = o.user ?? USER_A;
      this.credentials.push({ credential, userId: user.id, mode: o.mode });
      record(200);
      return json(200, {
        credential,
        token_type: 'Bearer',
        expires_in: 1800,
        absolute_expires_in: o.absoluteExpiresIn ?? (o.mode === 'dms-master' ? 28_800 : 1800),
        context: {
          sid: randomUUID(),
          mode: o.mode,
          tenant_id: TENANT,
          workspace_id: WORKSPACE,
          master_id: o.masterId ?? null,
          record_id: o.recordId ?? null,
          master_seed: o.seed === undefined ? (o.mode === 'dms-master' && !o.masterId ? { name: 'Vendor', doctype_ids: [], folder_ids: [], classification: null } : null) : o.seed,
          return_url: RETURN,
          reconnect_url: RECONNECT,
          user,
          can: { reveal_fields: false },
        },
      });
    }

    if (url.pathname.startsWith(`${SESSION_PREFIX}/`)) {
      for (const h of ['x-tenant-id', 'x-workspace-id']) if (h in headers) this.violations.push(`${request.method()} ${url.pathname} carried ${h}`);
      if ('cookie' in headers) this.violations.push(`${request.method()} ${url.pathname} carried a cookie`);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(headers['x-request-id'] ?? '')) this.violations.push(`${request.method()} ${url.pathname} has no UUID v4 X-Request-Id`);
      const bearer = /^Bearer (fps1_[A-Za-z0-9_-]{43})$/.exec(headers['authorization'] ?? '')?.[1];
      const known = this.credentials.find((c) => c.credential === bearer);
      if (!known || this.expired.has(known.credential)) {
        record(401);
        return json(401, err(401, 'FP_SESSION_INVALID', 'The session has ended.').body);
      }
      const route2 = url.pathname.slice(SESSION_PREFIX.length + 1);
      const legacy = legacyOf(route2, url.search);
      const answer = route2 === 'session' ? { status: 200, body: { success: true, data: { absolute_expires_in: 28_000 } } } : this.options.answer?.({ method: request.method(), route: `${route2}${url.search}`, legacy, body, headers });
      const out = answer ?? err(404, 'NOT_FOUND', 'This master or record is not available.');
      record(out.status);
      return json(out.status, out.body);
    }

    // Anything else under /api/dms/ is a request fORM- should not make in the ticket model (a legacy route, say).
    this.violations.push(`${request.method()} ${url.pathname} is not an exchange or session route`);
    record(404);
    return json(404, { message: 'unexpected' });
  }

  /** The DMS page: leaves the verifier in this tab's sessionStorage (only for a fragment that carries this ticket) and navigates. */
  async launch(page: Page, issued: Issued, opts: { withVerifier?: boolean } = {}): Promise<void> {
    if (opts.withVerifier !== false) {
      await page.addInitScript(
        ({ ticket, verifier }) => {
          if (location.hash.includes(ticket)) sessionStorage.setItem('fp.lv', verifier);
        },
        { ticket: issued.ticket, verifier: issued.verifier },
      );
    }
    await page.goto(`/embed/${issued.mode}#fpt=${issued.ticket}`);
  }
}

/** `master/form/<id>?x` -> the legacy path the fixtures use (`/dms/v1/master/form/<id>?x`). */
export function legacyOf(route: string, search = ''): string {
  const q = route.includes('?') ? '' : search;
  if (route.startsWith('master/form')) return `/dms/v1/${route}${q}`;
  if (route.startsWith('masters/')) return `/dms/${route}${q}`;
  if (route.startsWith('master-records')) return `/dms/${route}${q}`;
  return `/dms/${route}${q}`;
}

/**
 * The DMS reconnect page: reads `#c=<challenge>&mode=..&master_id=..&record_id=..`, asks the stub for a ticket bound to the challenge
 * (what `POST launch-tickets {reconnect: true}` does), broadcasts it on the channel and closes itself.
 */
const RECONNECT_PAGE = `<!doctype html><meta charset="utf-8"><title>DMS reconnect</title><p id="s">Reconnecting to Forms+...</p>
<script>
(async () => {
  const p = new URLSearchParams(location.hash.slice(1));
  const r = await fetch('/__stub/reconnect-ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge: p.get('c'), mode: p.get('mode') }) });
  const { ticket } = await r.json();
  const ch = new BroadcastChannel('fp-reconnect');
  ch.postMessage({ challenge: p.get('c'), ticket });
  document.getElementById('s').textContent = 'Reconnected. You can close this tab.';
  setTimeout(() => window.close(), 100);
})();
</script>`;

/** Starts the stub on the page's context. */
export async function stubDms(page: Page, options: StubOptions = {}): Promise<DmsStub> {
  const stub = new DmsStub(options);
  await stub.install(page.context());
  return stub;
}
