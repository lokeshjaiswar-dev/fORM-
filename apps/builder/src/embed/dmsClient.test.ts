import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_ROUTE_MAP } from '@/embed/contract';
import sessionFx from '@/embed/contract/__fixtures__/fp-session.fixtures.json' with { type: 'json' };
import { DmsApiError, DmsAuthError, createDmsClient, toSessionRoute } from '@/embed/dmsClient';
import { resetLaunchMemo } from '@/embed/launch';
import { installTestSession, resetTestSession, TEST_API_BASE, TEST_CREDENTIAL } from '@/embed/session/testing';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ID = 'a1000000-0000-4000-8000-000000000001';
const REC = 'c0ffee00-0000-4000-8000-000000000002';
const base = { apiBase: TEST_API_BASE, tenantId: 'acme', workspaceId: 'ws_1' };
const init = (fetch: ReturnType<typeof vi.fn>, n = 0) => fetch.mock.calls[n]![1] as RequestInit & { headers: Record<string, string> };

beforeEach(() => {
  resetLaunchMemo();
});
afterEach(() => {
  resetTestSession();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ── DT-08: the legacy-to-session path map ────────────────────────────────────────────────────────────────────── */

describe('DT-08 toSessionRoute: every row of SESSION_ROUTE_MAP', () => {
  const concrete = (template: string) => template.replace('{id}', REC);
  const rows = SESSION_ROUTE_MAP.filter((r) => r.legacy !== null);

  it.each(rows.map((r) => [`${r.method} ${r.legacy}`, r] as const))('%s', (_name, row) => {
    const hit = toSessionRoute(row.method, `/${concrete(row.legacy!)}`);
    expect(hit).toEqual({ name: row.name, path: concrete(row.session) });
  });

  it('is the same table the fixtures state (path map, methods, scopes, names)', () => {
    expect(sessionFx.routes.map((r) => ({ name: r.name, method: r.method, legacy: r.legacy, session: r.session, scope: r.scope }))).toEqual(SESSION_ROUTE_MAP.map((r) => ({ ...r })));
  });

  it('the paths the repositories really write map to the session group', () => {
    expect(toSessionRoute('POST', '/dms/v1/master/form').path).toBe('dms/v1/formplus/s/master/form');
    expect(toSessionRoute('GET', `/dms/v1/master/form/${ID}`).path).toBe(`dms/v1/formplus/s/master/form/${ID}`);
    expect(toSessionRoute('PATCH', `/dms/v1/master/form/${ID}`).path).toBe(`dms/v1/formplus/s/master/form/${ID}`);
    expect(toSessionRoute('GET', `/dms/v1/master/form/${ID}/field-usage`).path).toBe(`dms/v1/formplus/s/master/form/${ID}/field-usage`);
    expect(toSessionRoute('GET', `/dms/masters/${ID}`).path).toBe(`dms/v1/formplus/s/masters/${ID}`);
    expect(toSessionRoute('GET', `/dms/master-records/${REC}?master_id=${ID}`).path).toBe(`dms/v1/formplus/s/master-records/${REC}?master_id=${ID}`);
    expect(toSessionRoute('POST', '/dms/master-records').path).toBe('dms/v1/formplus/s/master-records');
    expect(toSessionRoute('PATCH', `/dms/master-records/${REC}`).path).toBe(`dms/v1/formplus/s/master-records/${REC}`);
  });

  it('keeps the query of a lookup search, encoded as the caller wrote it', () => {
    const hit = toSessionRoute('GET', `/dms/master-records?id=${ID}&q=acm%20%26%20co&page=1&per_page=21`);
    expect(hit).toEqual({ name: 'fp.s.master-records.index', path: `dms/v1/formplus/s/master-records?id=${ID}&q=acm%20%26%20co&page=1&per_page=21` });
  });

  it('accepts the path with or without the leading slash', () => {
    expect(toSessionRoute('POST', 'dms/v1/master/form').path).toBe(toSessionRoute('POST', '/dms/v1/master/form').path);
  });

  it('a template matches by method too: DELETE and PUT on a known path are unknown', () => {
    expect(() => toSessionRoute('DELETE', `/dms/v1/master/form/${ID}`)).toThrow(/no session route/);
    expect(() => toSessionRoute('PUT', `/dms/masters/${ID}`)).toThrow(/no session route/);
    expect(() => toSessionRoute('POST', `/dms/masters/${ID}`)).toThrow(/no session route/);
  });

  it.each([
    ['an unknown path', 'GET', '/dms/masters'],
    ['a list route', 'GET', '/dms/v1/master/form'],
    ['an extra segment', 'GET', `/dms/v1/master/form/${ID}/other`],
    ['a path of the other group', 'GET', `/dms/v1/formplus/s/master/form/${ID}`],
    ['the session route itself', 'GET', '/dms/v1/formplus/s/session'],
    ['the exchange route', 'POST', '/dms/v1/formplus/launch-tickets/exchange'],
    ['a document route', 'GET', '/dms/document/records/1'],
    ['dot segments', 'GET', `/dms/v1/master/form/../masters/${ID}`],
    ['an encoded dot segment', 'GET', '/dms/v1/master/form/%2e%2e'],
    ['an encoded slash', 'GET', '/dms/v1/master/form/a%2Fb'],
    ['an empty id', 'GET', '/dms/v1/master/form/'],
    ['a double slash', 'GET', '/dms//masters/1'],
    ['an absolute URL', 'GET', 'https://evil.example.test/dms/masters/1'],
    ['a scheme-relative URL', 'GET', '//evil.example.test/dms/masters/1'],
    ['a backslash', 'GET', '/dms\\masters/1'],
    ['a fragment', 'GET', `/dms/masters/${ID}#x`],
    ['a space', 'GET', '/dms/masters/a b'],
    ['a tenant in the query', 'GET', `/dms/master-records?id=${ID}&tenant_id=t2`],
    ['a workspace in the query (camel case, any case)', 'GET', `/dms/master-records?id=${ID}&WorkspaceId=w2`],
    ['an encoded tenant key', 'GET', `/dms/master-records?id=${ID}&tenant%5Fid=t2`],
    ['an empty path', 'GET', ''],
  ])('throws for %s and so nothing can be sent', (_name, method, path) => {
    expect(() => toSessionRoute(method, path)).toThrow(/no session route/);
  });

  it('createDmsClient sends nothing for an unknown path', async () => {
    installTestSession();
    const fetch = vi.fn();
    await expect(createDmsClient({ ...base, fetch: fetch as never }).request('GET', '/dms/document/records/1')).rejects.toThrow(/no session route/);
    await expect(createDmsClient({ ...base, fetch: fetch as never }).request('GET', '/dms/v1/formplus/s/master/form/x')).rejects.toThrow(/no session route/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

/* ── the request ──────────────────────────────────────────────────────────────────────────────────────────────── */

describe('createDmsClient (the session client)', () => {
  it('sends the session credential to the session route: no tenant or workspace header, no cookie, no referrer, a request id', async () => {
    installTestSession();
    const fetch = vi.fn().mockResolvedValue(json(200, { success: true }));
    await createDmsClient({ ...base, fetch: fetch as never }).request('POST', '/dms/v1/master/form', { a: 1 });
    const [url] = fetch.mock.calls[0] as [string];
    expect(url).toBe(`${TEST_API_BASE}/dms/v1/formplus/s/master/form`);
    expect(init(fetch)).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', body: '{"a":1}' });
    expect(init(fetch).headers).toEqual({ Authorization: `Bearer ${TEST_CREDENTIAL}`, Accept: 'application/json', 'X-Request-Id': expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), 'Content-Type': 'application/json' });
  });

  it("ignores a token option and the tenant and workspace it is given: the credential is the session's", async () => {
    installTestSession();
    const fetch = vi.fn().mockResolvedValue(json(200, {}));
    await createDmsClient({ ...base, fetch: fetch as never, token: () => 'cookie-canary' }).request('GET', `/dms/masters/${ID}`);
    const h = init(fetch).headers;
    expect(h.Authorization).toBe(`Bearer ${TEST_CREDENTIAL}`);
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('cookie-canary');
    expect(JSON.stringify(h)).not.toMatch(/acme|ws_1/);
  });

  it('a new request id for every call', async () => {
    installTestSession();
    const fetch = vi.fn().mockImplementation(async () => json(200, {}));
    const client = createDmsClient({ ...base, fetch: fetch as never });
    await client.request('GET', `/dms/masters/${ID}`);
    await client.request('GET', `/dms/masters/${ID}`);
    expect(init(fetch, 0).headers['X-Request-Id']).not.toBe(init(fetch, 1).headers['X-Request-Id']);
  });

  it('sends no body and no content type on a GET', async () => {
    installTestSession();
    const fetch = vi.fn().mockResolvedValue(json(200, {}));
    await createDmsClient({ ...base, fetch: fetch as never }).request('GET', `/dms/masters/${ID}`);
    expect(init(fetch)).not.toHaveProperty('body');
    expect(init(fetch).headers).not.toHaveProperty('Content-Type');
  });

  it('makes no request at all without a session (there is no fallback token)', async () => {
    const fetch = vi.fn();
    await expect(createDmsClient({ ...base, fetch: fetch as never }).request('GET', `/dms/masters/${ID}`)).rejects.toBeInstanceOf(DmsAuthError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a 401 that is not about the session (a ticket error, say) is a sign-in error at once, no waiting', async () => {
    installTestSession();
    const fetch = vi.fn().mockResolvedValue(json(401, { success: false, code: 'FP_TICKET_INVALID', message: 'x', request_id: null }));
    await expect(createDmsClient({ ...base, fetch: fetch as never }).request('GET', `/dms/masters/${ID}`)).rejects.toBeInstanceOf(DmsAuthError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps status, code, message and the request id of an error envelope', async () => {
    installTestSession();
    const rid = '5e510000-0000-4000-8000-0000000000aa';
    const fetch = vi.fn().mockResolvedValue(json(403, { success: false, code: 'FP_SCOPE_DENIED', message: 'Not allowed.', request_id: rid }));
    const err = await createDmsClient({ ...base, fetch: fetch as never }).request('PATCH', `/dms/v1/master/form/${ID}`, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DmsApiError);
    expect(err).toMatchObject({ status: 403, code: 'FP_SCOPE_DENIED', message: 'Not allowed.', requestId: rid });
  });

  it('falls back to the X-Request-Id it sent when the answer has none (an old-shape error)', async () => {
    installTestSession();
    const fetch = vi.fn().mockResolvedValue(json(409, { success: false, message: 'Master changed.', code: 'MASTER_CHANGED' }));
    const err = (await createDmsClient({ ...base, fetch: fetch as never }).request('PATCH', `/dms/v1/master/form/${ID}`, {}).catch((e: unknown) => e)) as DmsApiError;
    expect(err).toMatchObject({ status: 409, code: 'MASTER_CHANGED', message: 'Master changed.' });
    expect(err.requestId).toBe(init(fetch).headers['X-Request-Id']);
  });

  it('reads the first validation message, and copes with an empty or non-JSON body', async () => {
    installTestSession();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(422, { message: 'The given data was invalid.', errors: { 'form_builder_fields.0.name': ['The name is too long.'] } }))
      .mockResolvedValueOnce(json(422, { errors: { name: ['Name is required.'] } }))
      .mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    const client = createDmsClient({ ...base, fetch: fetch as never });
    const path = `/dms/v1/master/form/${ID}`;
    expect(await client.request('PATCH', path, {}).catch((e: Error) => e.message)).toBe('The given data was invalid. The name is too long.');
    expect(await client.request('PATCH', path, {}).catch((e: Error) => e.message)).toBe('Name is required.');
    expect(await client.request('PATCH', path, {}).catch((e: Error) => e.message)).toBe('DMS answered 502.');
    expect(await client.request('PATCH', path, {}).catch((e: Error) => e.message)).toBe('DMS answered 500.');
  });

  it('says so when DMS cannot be reached, and when it does not answer in 30 seconds', async () => {
    installTestSession();
    const down = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createDmsClient({ ...base, fetch: down as never }).request('GET', `/dms/masters/${ID}`)).rejects.toThrow(/cannot be reached \(Failed to fetch\)/);
    vi.useFakeTimers();
    const hang = vi.fn((_u: string, i: RequestInit) => new Promise<Response>((_res, rej) => i.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
    const pending = createDmsClient({ ...base, fetch: hang as never }).request('GET', `/dms/masters/${ID}`);
    const assertion = expect(pending).rejects.toThrow(/did not answer in time/);
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
  });
});
