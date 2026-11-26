import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ticketFx from '@/embed/contract/__fixtures__/launch-ticket.fixtures.json' with { type: 'json' };
import { createDmsClient, DmsAuthError } from '@/embed/dmsClient';
import { resetLaunchMemo } from '@/embed/launch';
import { dismissReconnect, enterResume, sessionContext, sessionSnapshot } from './dmsSession';
import { challengeOf } from './pkce';
import { prepareReconnect, reconnectTabUrl, sameIdentity, type ChannelLike, type ExpectedIdentity, type ReconnectTarget } from './reconnect';
import { installTestSession, resetTestSession, TEST_API_BASE, TEST_CREDENTIAL, testEnv } from './testing';

/*
 * The reconnect of SEC-DESIGN 1.7 (T-DMSINT-57 unit side): a fresh in-memory verifier, the DMS tab opened by the click, a
 * BroadcastChannel listened to for OUR challenge only, the new context compared with the page's, and the parked request resumed once.
 */

const { ticket: TICKET } = ticketFx.samples;
const MASTER = 'a1000000-0000-4000-8000-000000000001';
const NEW_CREDENTIAL = 'fps1_NEWnewNEWnewNEWnewNEWnewNEWnewNEWnewNEWnew0';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const exchangeInput = (name: string) => ticketFx.exchangeResponse.find((c) => c.name === name)!.input as { credential: string; context: { user: Record<string, unknown> } & Record<string, unknown> };

class FakeChannel implements ChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
  deliver(data: unknown) {
    this.onmessage?.({ data });
  }
}

/** The answer of the exchange for a reconnect: the fixture's edit session with a new credential and, optionally, other identity fields. */
function reconnectAnswer(contextOver: Record<string, unknown> = {}, userId?: string) {
  const base = exchangeInput('edit');
  return { ...base, credential: NEW_CREDENTIAL, context: { ...base.context, ...contextOver, ...(userId ? { user: { ...base.context.user, id: userId } } : {}) } };
}

beforeEach(() => {
  resetLaunchMemo();
});
afterEach(() => {
  resetTestSession();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(over: { answer?: unknown; contextOver?: Record<string, unknown> } = {}) {
  const exchanges: Array<{ url: string; init: RequestInit & { headers: Record<string, string> } }> = [];
  const calls: Array<{ url: string; init: RequestInit & { headers: Record<string, string> } }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
    const entry = { url: String(url), init };
    (String(url).endsWith('/launch-tickets/exchange') ? exchanges : calls).push(entry);
    if (String(url).endsWith('/launch-tickets/exchange')) return json(200, over.answer ?? reconnectAnswer());
    return json(200, { success: true, data: { id: 'ok' } });
  });
  installTestSession({ fetch: fetch as never, context: { master_id: MASTER, ...over.contextOver } });
  const ctx = sessionContext()!;
  const channel = new FakeChannel();
  const openWindow = vi.fn();
  const target: ReconnectTarget = { mode: ctx.mode, masterId: ctx.master_id, recordId: ctx.record_id, reconnectUrl: ctx.reconnect_url, apiBase: TEST_API_BASE };
  const expected: ExpectedIdentity = { mode: ctx.mode, master_id: ctx.master_id, record_id: ctx.record_id, tenant_id: ctx.tenant_id, workspace_id: ctx.workspace_id, user_id: ctx.user.id };
  const handle = await prepareReconnect(target, expected, testEnv(), { fetch: fetch as never, openWindow, createChannel: () => channel });
  return { fetch, exchanges, calls, channel, openWindow, handle, ctx, target, expected };
}

describe('the DMS tab', () => {
  it('opens reconnect_url with #c=<challenge>&mode=..&master_id=..; record_id only when there is one', async () => {
    const { handle, openWindow, ctx } = await setup();
    handle.open();
    const url = new URL(openWindow.mock.calls[0]![0] as string);
    expect(`${url.origin}${url.pathname}`).toBe(ctx.reconnect_url);
    const params = new URLSearchParams(url.hash.slice(1));
    expect(Object.fromEntries(params)).toEqual({ c: handle.challenge, mode: 'dms-master', master_id: MASTER });
    expect(handle.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionSnapshot().reconnect).toBe('waiting');
    expect(reconnectTabUrl('https://dms.example.test/dms/t/formplus/reconnect', 'c'.repeat(43), { mode: 'dms-record', masterId: MASTER, recordId: 'r-1' })).toContain('record_id=r-1');
  });

  it('refuses a reconnect URL that is not on the allowlist, and a browser without BroadcastChannel', async () => {
    installTestSession();
    const ctx = sessionContext()!;
    const target = { mode: ctx.mode, masterId: null, recordId: null, apiBase: TEST_API_BASE };
    await expect(prepareReconnect({ ...target, reconnectUrl: 'https://evil.example.test/dms/x' }, { mode: ctx.mode, master_id: null, record_id: null }, testEnv(), { createChannel: () => new FakeChannel() })).rejects.toThrow(/cannot reconnect/);
    await expect(prepareReconnect({ ...target, reconnectUrl: ctx.reconnect_url }, { mode: ctx.mode, master_id: null, record_id: null }, testEnv(), { createChannel: () => null })).rejects.toThrow(/cannot reconnect/);
  });
});

describe('the exchange of a reconnect ticket', () => {
  it('uses the in-memory verifier whose S256 is the challenge the DMS tab was given, and no Authorization', async () => {
    const { handle, channel, exchanges } = await setup();
    handle.open();
    channel.deliver({ challenge: handle.challenge, ticket: TICKET });
    await vi.waitFor(() => expect(exchanges).toHaveLength(1));
    const body = JSON.parse(exchanges[0]!.init.body as string) as { ticket: string; verifier: string };
    expect(body.ticket).toBe(TICKET);
    expect(await challengeOf(body.verifier)).toBe(handle.challenge);
    expect(Object.keys(exchanges[0]!.init.headers)).not.toContain('Authorization');
    expect(sessionStorage.getItem('fp.lv')).toBeNull();
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(body.verifier);
  });

  it('ignores a message for another challenge, with extra keys, or with a malformed ticket: no exchange', async () => {
    const { handle, channel, exchanges } = await setup();
    handle.open();
    channel.deliver({ challenge: 'x'.repeat(43), ticket: TICKET });
    channel.deliver({ challenge: handle.challenge, ticket: TICKET, extra: 'x' });
    channel.deliver({ challenge: handle.challenge, ticket: 'not-a-ticket' });
    channel.deliver('hello');
    channel.deliver(null);
    channel.deliver({ ticket: TICKET });
    await new Promise((r) => setTimeout(r, 20));
    expect(exchanges).toHaveLength(0);
    expect(sessionSnapshot().reconnect).toBe('waiting');
  });

  it('a second message for the same challenge exchanges nothing more (a ticket is single use)', async () => {
    const { handle, channel, exchanges } = await setup();
    handle.open();
    channel.deliver({ challenge: handle.challenge, ticket: TICKET });
    channel.deliver({ challenge: handle.challenge, ticket: TICKET });
    await vi.waitFor(() => expect(sessionSnapshot().reconnect).toBe('idle'));
    expect(exchanges).toHaveLength(1);
    expect(channel.closed).toBe(true);
  });
});

describe('same identity: the page continues', () => {
  it('swaps the credential, keeps the page context, and the parked request is retried ONCE with the new credential', async () => {
    const state = await setup();
    const { fetch, calls, channel, handle } = state;
    // The save fails with 401 FP_SESSION_INVALID the first time, then succeeds.
    fetch.mockImplementation(async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
      const entry = { url: String(url), init };
      if (String(url).endsWith('/launch-tickets/exchange')) {
        state.exchanges.push(entry);
        return json(200, reconnectAnswer());
      }
      calls.push(entry);
      return calls.length === 1 ? json(401, { success: false, code: 'FP_SESSION_INVALID', message: 'Session ended.', request_id: null }) : json(200, { success: true, data: { id: MASTER } });
    });
    const client = createDmsClient({ apiBase: TEST_API_BASE, tenantId: 't', workspaceId: 'w', fetch: fetch as never });
    const save = client.request<{ data: { id: string } }>('PATCH', `/dms/v1/master/form/${MASTER}`, { name: 'Vendor', updated_at: 'T1' });
    await vi.waitFor(() => expect(sessionSnapshot().phase).toBe('invalid'));
    // The call is parked: no second request yet, the page and its context are kept.
    expect(calls).toHaveLength(1);
    expect(sessionContext()).not.toBeNull();

    handle.open();
    channel.deliver({ challenge: handle.challenge, ticket: TICKET });
    await expect(save).resolves.toEqual({ success: true, data: { id: MASTER } });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init.headers.Authorization).toBe(`Bearer ${TEST_CREDENTIAL}`);
    expect(calls[1]!.init.headers.Authorization).toBe(`Bearer ${NEW_CREDENTIAL}`);
    expect(calls[1]!.init.body).toBe(calls[0]!.init.body);
    expect(calls[1]!.init.headers['X-Request-Id']).not.toBe(calls[0]!.init.headers['X-Request-Id']);
    expect(sessionSnapshot()).toMatchObject({ phase: 'active', reconnect: 'idle', dismissed: false });
  });

  it('retries only once: a second 401 after the reconnect is a DmsAuthError, not another wait', async () => {
    const state = await setup();
    const { fetch, channel, handle } = state;
    fetch.mockImplementation(async (url: string) => (String(url).endsWith('/launch-tickets/exchange') ? json(200, reconnectAnswer()) : json(401, { success: false, code: 'FP_SESSION_INVALID', message: 'x', request_id: null })));
    const save = createDmsClient({ apiBase: TEST_API_BASE, tenantId: 't', workspaceId: 'w', fetch: fetch as never }).request('PATCH', `/dms/v1/master/form/${MASTER}`, {});
    const outcome = save.catch((e: unknown) => e);
    await vi.waitFor(() => expect(sessionSnapshot().phase).toBe('invalid'));
    handle.open();
    channel.deliver({ challenge: handle.challenge, ticket: TICKET });
    expect(await outcome).toBeInstanceOf(DmsAuthError);
  });

  it('dismissing the prompt rejects the parked request with DmsAuthError; a later 401 shows the prompt again', async () => {
    const { fetch } = await setup();
    fetch.mockImplementation(async () => json(401, { success: false, code: 'FP_SESSION_INVALID', message: 'x', request_id: null }));
    const client = createDmsClient({ apiBase: TEST_API_BASE, tenantId: 't', workspaceId: 'w', fetch: fetch as never });
    const first = client.request('GET', `/dms/v1/master/form/${MASTER}`).catch((e: unknown) => e);
    await vi.waitFor(() => expect(sessionSnapshot().phase).toBe('invalid'));
    dismissReconnect();
    expect(await first).toBeInstanceOf(DmsAuthError);
    expect(sessionSnapshot().dismissed).toBe(true);
    const second = client.request('GET', `/dms/v1/master/form/${MASTER}`).catch((e: unknown) => e);
    await vi.waitFor(() => expect(sessionSnapshot().dismissed).toBe(false));
    dismissReconnect();
    expect(await second).toBeInstanceOf(DmsAuthError);
  });

  it('a 401 FP_CONTEXT_MISMATCH parks the call too', async () => {
    const { fetch } = await setup();
    fetch.mockImplementation(async () => json(401, { success: false, code: 'FP_CONTEXT_MISMATCH', message: 'x', request_id: null }));
    const call = createDmsClient({ apiBase: TEST_API_BASE, tenantId: 't', workspaceId: 'w', fetch: fetch as never }).request('GET', `/dms/v1/master/form/${MASTER}`).catch((e: unknown) => e);
    await vi.waitFor(() => expect(sessionSnapshot().phase).toBe('invalid'));
    dismissReconnect();
    expect(await call).toBeInstanceOf(DmsAuthError);
  });
});

describe('another identity: "You are signed in as someone else"', () => {
  const OTHERS: Array<[string, Record<string, unknown>, string?]> = [
    ['another user', {}, 'b0000000-0000-4000-8000-0000000000ff'],
    ['another tenant', { tenant_id: '22222222-2222-4222-8222-222222222222' }],
    ['another workspace', { workspace_id: '0a000000-0000-4000-8000-0000000000ff' }],
    ['another master', { master_id: 'a1000000-0000-4000-8000-0000000000ff' }],
    ['a record where there was none', { record_id: 'rec-9' }],
  ];
  for (const [name, over, user] of OTHERS) {
    it(`${name}: the page is blocked, the new credential is discarded and never sent`, async () => {
      const { fetch, channel, handle, calls } = await setup({ answer: reconnectAnswer(over, user) });
      fetch.mockImplementation(async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
        if (String(url).endsWith('/launch-tickets/exchange')) return json(200, reconnectAnswer(over, user));
        calls.push({ url: String(url), init });
        return json(401, { success: false, code: 'FP_SESSION_INVALID', message: 'x', request_id: null });
      });
      const client = createDmsClient({ apiBase: TEST_API_BASE, tenantId: 't', workspaceId: 'w', fetch: fetch as never });
      const save = client.request('PATCH', `/dms/v1/master/form/${MASTER}`, {}).catch((e: unknown) => e);
      await vi.waitFor(() => expect(sessionSnapshot().phase).toBe('invalid'));
      handle.open();
      channel.deliver({ challenge: handle.challenge, ticket: TICKET });
      expect(await save).toBeInstanceOf(DmsAuthError);
      expect(sessionSnapshot().phase).toBe('mismatch');
      // Nothing carries the new credential, now or later.
      const before = fetch.mock.calls.length;
      await expect(client.request('GET', `/dms/v1/master/form/${MASTER}`)).rejects.toBeInstanceOf(DmsAuthError);
      expect(fetch.mock.calls.length).toBe(before);
      for (const [, init] of fetch.mock.calls) expect(JSON.stringify(init)).not.toContain(NEW_CREDENTIAL);
      expect(JSON.stringify(sessionSnapshot())).not.toContain(NEW_CREDENTIAL);
    });
  }

  it('sameIdentity compares tenant, workspace, user, mode, master and record', () => {
    const ctx = installTestSession();
    const expected: ExpectedIdentity = { mode: ctx.mode, master_id: ctx.master_id, record_id: ctx.record_id, tenant_id: ctx.tenant_id, workspace_id: ctx.workspace_id, user_id: ctx.user.id };
    expect(sameIdentity(ctx, expected)).toBe(true);
    expect(sameIdentity({ ...ctx, mode: 'dms-record' }, expected)).toBe(false);
    expect(sameIdentity(ctx, { ...expected, user_id: 'someone-else' })).toBe(false);
  });
});

describe('a failed exchange of the reconnect ticket', () => {
  it('is shown as failed; the page stays as it was and a fresh attempt can be prepared', async () => {
    const { fetch, channel, handle } = await setup();
    fetch.mockImplementation(async () => json(401, { success: false, code: 'FP_TICKET_INVALID', message: 'x', request_id: null }));
    handle.open();
    channel.deliver({ challenge: handle.challenge, ticket: TICKET });
    await vi.waitFor(() => expect(sessionSnapshot().reconnect).toBe('failed'));
    expect(sessionContext()).not.toBeNull();
    expect(channel.closed).toBe(true);
  });
});

describe('after a reload (the resume hint)', () => {
  it('a matching mode, master and record come back: the context is set and the page loads', async () => {
    const fetch = vi.fn(async () => json(200, reconnectAnswer()));
    const hint = { mode: 'dms-master' as const, master_id: MASTER, record_id: null, reconnect_url: 'https://dms.example.test/dms/t1/formplus/reconnect', return_url: 'https://dms.example.test/dms/t1/documents/master' };
    resetTestSession();
    enterResume(hint);
    const channel = new FakeChannel();
    const handle = await prepareReconnect(
      { mode: hint.mode, masterId: hint.master_id, recordId: hint.record_id, reconnectUrl: hint.reconnect_url, apiBase: TEST_API_BASE },
      { mode: hint.mode, master_id: hint.master_id, record_id: hint.record_id },
      testEnv(),
      { fetch: fetch as never, openWindow: vi.fn(), createChannel: () => channel },
    );
    handle.open();
    channel.deliver({ challenge: handle.challenge, ticket: TICKET });
    await vi.waitFor(() => expect(sessionSnapshot().phase).toBe('active'));
    expect(sessionContext()).toMatchObject({ mode: 'dms-master', master_id: MASTER });
    expect(sessionSnapshot().apiBase).toBe(TEST_API_BASE);
  });

  it('another master than the hint names is a mismatch', async () => {
    const fetch = vi.fn(async () => json(200, reconnectAnswer({ master_id: 'a1000000-0000-4000-8000-0000000000ff' })));
    resetTestSession();
    const hint = { mode: 'dms-master' as const, master_id: MASTER, record_id: null, reconnect_url: 'https://dms.example.test/dms/t1/formplus/reconnect', return_url: 'https://dms.example.test/dms/t1/documents/master' };
    enterResume(hint);
    const channel = new FakeChannel();
    const handle = await prepareReconnect({ mode: hint.mode, masterId: MASTER, recordId: null, reconnectUrl: hint.reconnect_url, apiBase: TEST_API_BASE }, { mode: hint.mode, master_id: MASTER, record_id: null }, testEnv(), { fetch: fetch as never, openWindow: vi.fn(), createChannel: () => channel });
    handle.open();
    channel.deliver({ challenge: handle.challenge, ticket: TICKET });
    await vi.waitFor(() => expect(sessionSnapshot().phase).toBe('mismatch'));
  });
});
