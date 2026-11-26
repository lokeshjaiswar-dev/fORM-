import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ticketFx from '@/embed/contract/__fixtures__/launch-ticket.fixtures.json' with { type: 'json' };
import { createDmsClient, DmsAuthError } from '@/embed/dmsClient';
import { resetLaunchMemo } from '@/embed/launch';
import { authorizedFetch, ExchangeError, exchangeTicket, leaveSession, sessionApiBase, sessionContext, sessionSnapshot } from './dmsSession';
import { startLaunch } from './launchFlow';
import { installTestSession, resetTestSession, TEST_API_BASE, TEST_CREDENTIAL, testEnv } from './testing';

/*
 * T-DMSINT-54 (SEC-DESIGN 10.3): the credential lives in one module variable and goes only into `Authorization` of a request to the
 * allowlisted base. No tenant or workspace header, never in storage, never on `window`, never in a log line or an error, redirects are
 * errors and cookies are not sent. Plus the exchange, the keep-alive, the absolute-expiry prompt and leaving.
 */

const { ticket: TICKET, verifier: VERIFIER } = ticketFx.samples;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const exchangeBody = (name = 'create') => ticketFx.exchangeResponse.find((c) => c.name === name)!.input;
const sentOf = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([url, init]) => ({ url: String(url), init: (init ?? {}) as RequestInit & { headers: Record<string, string> } }));

beforeEach(() => {
  resetLaunchMemo();
  window.history.replaceState(null, '', '/embed/dms-master');
});
afterEach(() => {
  resetTestSession();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('exchangeTicket', () => {
  it('POSTs {ticket, verifier} to the exchange route with no Authorization, no cookie, no redirect and no referrer', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, exchangeBody()));
    await exchangeTicket({ apiBase: TEST_API_BASE, ticket: TICKET, verifier: VERIFIER, fetch });
    const [call] = sentOf(fetch);
    expect(call!.url).toBe(`${TEST_API_BASE}/dms/v1/formplus/launch-tickets/exchange`);
    expect(call!.init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(call!.init.body as string)).toEqual({ ticket: TICKET, verifier: VERIFIER });
    expect(Object.keys(call!.init.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(call!.init.headers['X-Request-Id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });

  it.each(ticketFx.exchangeResponse)('validates the answer with the contract schema: $name', async (c) => {
    const fetch = vi.fn().mockResolvedValue(json(200, c.input));
    const run = exchangeTicket({ apiBase: TEST_API_BASE, ticket: TICKET, verifier: VERIFIER, fetch });
    if (c.expect.valid) await expect(run).resolves.toMatchObject({ token_type: 'Bearer' });
    else await expect(run).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('every failure of the exchange has one reason the page can show, and none carries the ticket, verifier or body', async () => {
    const cases: Array<[Response | Error, string]> = [
      [json(401, { success: false, code: 'FP_TICKET_INVALID', message: 'x', request_id: null }), 'ticket_invalid'],
      [json(401, {}), 'ticket_invalid'],
      [json(503, { success: false, code: 'LAUNCH_STORE_UNAVAILABLE', message: 'x', request_id: null }), 'unavailable'],
      [json(429, { success: false, code: 'RATE_LIMITED', message: 'x', request_id: null }), 'unavailable'],
      [json(403, { success: false, code: 'FP_ORIGIN_DENIED', message: 'x', request_id: null }), 'rejected'],
      [new Response('<html>Bad gateway</html>', { status: 502 }), 'rejected'],
      [new TypeError('Failed to fetch'), 'unreachable'],
    ];
    for (const [answer, reason] of cases) {
      const fetch = answer instanceof Error ? vi.fn().mockRejectedValue(answer) : vi.fn().mockResolvedValue(answer);
      const err = await exchangeTicket({ apiBase: TEST_API_BASE, ticket: TICKET, verifier: VERIFIER, fetch }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExchangeError);
      expect(err).toMatchObject({ reason });
      expect(String((err as Error).message) + JSON.stringify(err)).not.toContain(TICKET);
      expect(String((err as Error).message) + JSON.stringify(err)).not.toContain(VERIFIER);
    }
  });
});

describe('T-DMSINT-54 the credential', () => {
  /** A full launch through the real path: fragment, exchange, install; then page calls through the session client. */
  async function launched() {
    sessionStorage.setItem('fp.lv', VERIFIER);
    window.history.replaceState(null, '', `/embed/dms-master#fpt=${TICKET}`);
    const fetch = vi.fn(async (url: string) => (String(url).endsWith('/launch-tickets/exchange') ? json(200, exchangeBody('edit')) : json(200, { success: true, data: { id: 'x' } })));
    const outcome = await startLaunch('dms-master', { env: testEnv(), fetch: fetch as never });
    expect(outcome).toEqual({ kind: 'session' });
    return fetch;
  }

  it('goes only into Authorization, to the allowlisted base, with no tenant or workspace header, no cookie, no redirect', async () => {
    const fetch = await launched();
    const client = createDmsClient({ apiBase: TEST_API_BASE, tenantId: 'ignored-tenant', workspaceId: 'ignored-ws', fetch: fetch as never });
    await client.request('GET', '/dms/v1/master/form/a1000000-0000-4000-8000-000000000001');
    await client.request('PATCH', '/dms/v1/master/form/a1000000-0000-4000-8000-000000000001', { name: 'V' });
    await client.request('GET', '/dms/master-records?id=a1000000-0000-4000-8000-000000000001&q=ac&page=1&per_page=21');
    const calls = sentOf(fetch).slice(1);
    expect(calls).toHaveLength(3);
    for (const { url, init } of calls) {
      expect(url.startsWith(`${TEST_API_BASE}/dms/v1/formplus/s/`)).toBe(true);
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      expect(init.headers.Authorization).toBe(`Bearer ${TEST_CREDENTIAL}`);
      const names = Object.keys(init.headers).map((h) => h.toLowerCase());
      expect(names).not.toContain('x-tenant-id');
      expect(names).not.toContain('x-workspace-id');
      expect(names).toContain('x-request-id');
      // The credential appears in exactly one place of a request: the Authorization header.
      expect(url).not.toContain(TEST_CREDENTIAL);
      expect(String(init.body ?? '')).not.toContain(TEST_CREDENTIAL);
      for (const [name, value] of Object.entries(init.headers)) if (name !== 'Authorization') expect(value).not.toContain(TEST_CREDENTIAL);
    }
    // The exchange itself carried no Authorization and the ticket/verifier only in its body.
    expect(Object.keys(sentOf(fetch)[0]!.init.headers)).not.toContain('Authorization');
  });

  it('never reaches storage: Storage.prototype.setItem and the stored values hold no credential, and it is not on window', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const fetch = await launched();
    await createDmsClient({ apiBase: TEST_API_BASE, tenantId: 't', workspaceId: 'w', fetch: fetch as never }).request('GET', '/dms/masters/a1000000-0000-4000-8000-000000000001');
    const credential = exchangeBody('edit').credential;
    for (const [key, value] of setItem.mock.calls) {
      expect(String(key)).not.toContain(credential);
      expect(String(value)).not.toContain(credential);
    }
    for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i++) expect(`${store.key(i)}=${store.getItem(store.key(i)!)}`).not.toContain(credential);
    // Not on window (own or inherited, enumerable or not), not in the document, not in the address bar.
    const onWindow = Object.getOwnPropertyNames(window).filter((k) => {
      try {
        const v = (window as unknown as Record<string, unknown>)[k];
        return k.includes(credential) || (typeof v === 'string' && v.includes(credential));
      } catch {
        return false;
      }
    });
    expect(onWindow).toEqual([]);
    expect(document.documentElement.outerHTML).not.toContain(credential);
    expect(window.location.href).not.toContain(credential);
    // And the readable snapshot the UI sees does not carry it.
    expect(JSON.stringify(sessionSnapshot())).not.toContain(credential);
  });

  it('the resume hint written for a reload holds no secret', async () => {
    await launched();
    const hint = sessionStorage.getItem('fp.resume') ?? '';
    expect(hint).not.toMatch(/fps1_|fpt1_/);
    expect(JSON.parse(hint)).toMatchObject({ mode: 'dms-master', master_id: 'a1000000-0000-4000-8000-000000000001' });
  });

  it('is not put in an error or a log line when a call fails', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')];
    const fetch = await launched();
    fetch.mockResolvedValue(json(409, { success: false, code: 'MASTER_CHANGED', message: 'Master changed.', request_id: null }));
    const err = await createDmsClient({ apiBase: TEST_API_BASE, tenantId: 't', workspaceId: 'w', fetch: fetch as never })
      .request('PATCH', '/dms/v1/master/form/a1000000-0000-4000-8000-000000000001', {})
      .catch((e: unknown) => e);
    const credential = exchangeBody('edit').credential;
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(credential);
    for (const l of logs) expect(JSON.stringify(l.mock.calls)).not.toContain(credential);
  });

  it('is sent nowhere else: authorizedFetch refuses a URL outside the session base, and a client naming another base', async () => {
    const fetch = await launched();
    const other = vi.fn();
    expect(() => authorizedFetch(other as never, 'https://evil.example.test/api/dms/x', { method: 'GET' })).toThrow(/outside the DMS API base/);
    expect(() => authorizedFetch(other as never, `${TEST_API_BASE}.evil.example.test/x`, { method: 'GET' })).toThrow(/outside the DMS API base/);
    expect(other).not.toHaveBeenCalled();
    const stray = createDmsClient({ apiBase: 'https://evil.example.test/api', tenantId: 't', workspaceId: 'w', fetch: fetch as never });
    const before = fetch.mock.calls.length;
    await expect(stray.request('GET', '/dms/masters/a1000000-0000-4000-8000-000000000001')).rejects.toThrow(/only to the DMS API base of the launch/);
    expect(fetch.mock.calls.length).toBe(before);
  });

  it('there is no request at all without a session: no fallback token, nothing read from cookies or storage', async () => {
    document.cookie = 'token=cookie-canary; path=/';
    localStorage.setItem('token', 'storage-canary');
    const fetch = vi.fn();
    await expect(createDmsClient({ apiBase: TEST_API_BASE, tenantId: 't', workspaceId: 'w', fetch: fetch as never }).request('GET', '/dms/masters/a1000000-0000-4000-8000-000000000001')).rejects.toBeInstanceOf(DmsAuthError);
    expect(fetch).not.toHaveBeenCalled();
    document.cookie = 'token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    localStorage.clear();
  });
});

describe('what a page learns from the session', () => {
  it('currentLaunch is built from the exchange context; tenant and workspace are for display only', async () => {
    installTestSession({ context: { master_id: 'a1000000-0000-4000-8000-000000000001' } });
    const { currentLaunch } = await import('@/embed/launch');
    const r = currentLaunch('dms-master');
    expect(r).toMatchObject({ ok: true, launch: { mode: 'dms-master', masterId: 'a1000000-0000-4000-8000-000000000001', apiBase: TEST_API_BASE, returnUrl: expect.stringContaining('/documents/master'), tenantId: sessionContext()!.tenant_id } });
    expect(sessionApiBase()).toBe(TEST_API_BASE);
  });
});

describe('keep-alive and the absolute-expiry prompt (SEC 1.7)', () => {
  const keepAlive = (fetch: ReturnType<typeof vi.fn>) => sentOf(fetch).filter((c) => c.init.method === 'GET' && c.url.endsWith('/dms/v1/formplus/s/session'));
  const MIN = 60_000;

  it('GET s/session every 10 minutes while the tab is visible AND the user typed or clicked in the last 10 minutes', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(json(200, { success: true, data: { absolute_expires_in: 28_000 } }));
    installTestSession({ fetch: fetch as never, absoluteExpiresIn: 28_800 });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    await vi.advanceTimersByTimeAsync(5 * MIN + 100); // the 10-minute tick: typed 5 minutes ago
    expect(keepAlive(fetch)).toHaveLength(1);
    expect(keepAlive(fetch)[0]!.init.headers.Authorization).toBe(`Bearer ${TEST_CREDENTIAL}`);
    await vi.advanceTimersByTimeAsync(10 * MIN); // the 20-minute tick: last input was 15 minutes ago
    expect(keepAlive(fetch)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    window.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(6 * MIN); // the 30-minute tick: clicked 6 minutes ago
    expect(keepAlive(fetch)).toHaveLength(2);
  });

  it('sends nothing when the user has been idle for 10 minutes, or the tab is hidden', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(json(200, {}));
    installTestSession({ fetch: fetch as never });
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(keepAlive(fetch)).toHaveLength(0);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(keepAlive(fetch)).toHaveLength(0);
    hidden.mockRestore();
  });

  it('a 401 on the keep-alive offers Reconnect (phase invalid); the page is kept', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(json(401, { success: false, code: 'FP_SESSION_INVALID', message: 'x', request_id: null }));
    installTestSession({ fetch: fetch as never });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    await vi.advanceTimersByTimeAsync(5 * MIN + 100);
    expect(sessionSnapshot().phase).toBe('invalid');
    expect(sessionContext()).not.toBeNull();
  });

  it('5 minutes before the absolute expiry the Reconnect prompt appears', async () => {
    vi.useFakeTimers();
    installTestSession({ fetch: vi.fn().mockResolvedValue(json(200, {})) as never, absoluteExpiresIn: 1800 });
    await vi.advanceTimersByTimeAsync(24 * MIN);
    expect(sessionSnapshot().phase).toBe('active');
    await vi.advanceTimersByTimeAsync(1 * MIN + 100);
    expect(sessionSnapshot().phase).toBe('expiring');
  });

  it('adopts the server-reported remaining time from the keep-alive answer', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(json(200, { success: true, data: { sid: 'x', absolute_expires_in: 400 } }));
    installTestSession({ fetch: fetch as never, absoluteExpiresIn: 28_800 });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    await vi.advanceTimersByTimeAsync(5 * MIN + 100);
    // 400 s remain at the first keep-alive: the prompt is due 100 s later (5 minutes = 300 s before the end).
    await vi.advanceTimersByTimeAsync(101_000);
    expect(sessionSnapshot().phase).toBe('expiring');
  });
});

describe('leaving', () => {
  it('DELETE s/session with keepalive on pagehide, and the credential is gone afterwards', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, {}));
    installTestSession({ fetch: fetch as never });
    window.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [call] = sentOf(fetch);
    expect(call!.url).toBe(`${TEST_API_BASE}/dms/v1/formplus/s/session`);
    expect(call!.init).toMatchObject({ method: 'DELETE', keepalive: true, credentials: 'omit', redirect: 'error' });
    expect(call!.init.headers.Authorization).toBe(`Bearer ${TEST_CREDENTIAL}`);
    await vi.waitFor(() => expect(sessionSnapshot().phase).toBe('ended'));
    await expect(createDmsClient({ apiBase: TEST_API_BASE, tenantId: 't', workspaceId: 'w', fetch: fetch as never }).request('GET', '/dms/masters/a1000000-0000-4000-8000-000000000001')).rejects.toBeInstanceOf(DmsAuthError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('leaveSession twice sends one DELETE; "forget" also drops the resume hint', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, {}));
    installTestSession({ fetch: fetch as never });
    expect(sessionStorage.getItem('fp.resume')).not.toBeNull();
    await leaveSession({ forget: true });
    await leaveSession();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('fp.resume')).toBeNull();
  });

  it('a failing DELETE does not throw (the server idle TTL ends the session anyway)', async () => {
    installTestSession({ fetch: vi.fn().mockRejectedValue(new TypeError('offline')) as never });
    await expect(leaveSession()).resolves.toBeUndefined();
  });
});
