import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore, type Me } from '@/auth/client';
import { addApiCredential, listApiCredentials, proxySource, RemoteFailed, testRemote, testRequestOf } from '@/persistence/remoteApi';

const ME: Me = {
  user: { id: 'u1', email: 'a@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const SECRET = 'sentinel-secret-9f3a1c77';

let calls: Array<{ url: string; init: RequestInit; body: any }> = [];
function stub(answer: (url: string, init: RequestInit) => Response) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      calls.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      return Promise.resolve(answer(url, init));
    }),
  );
}

beforeEach(() => useSessionStore.setState({ status: 'signed_in', me: ME }, true));
afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('proxySource (T-LK-01, T-LK-07: the respondent sends ids and typed values only)', () => {
  const scope = { slug: 'staff', versionId: 'v1', token: () => 'tok' as string | null };

  it('posts the lookup term to the version-scoped route, anonymously, with the access token', async () => {
    stub(() => json(200, { rows: [{ label: 'Asha', cells: { name: 'Asha' } }], truncated: false }));
    const out = await proxySource(scope).lookup('hr', 'as', new AbortController().signal);
    expect(out.rows[0]?.label).toBe('Asha');
    const [call] = calls;
    expect(call?.url).toMatch(/\/v1\/p\/staff\/lookups\/hr$/);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.credentials).toBe('omit');
    expect((call?.init.headers as Record<string, string>)['x-fr-access']).toBe('tok');
    expect(call?.body).toEqual({ formVersionId: 'v1', q: 'as' });
  });

  it('sends options and checks by block id, with no URL, key or header of the author', async () => {
    stub((url) => (url.endsWith('/options') ? json(200, { options: [{ id: 'a', label: 'A' }] }) : json(200, { ok: true })));
    const source = proxySource({ ...scope, token: () => null });
    await source.options!('b1', new AbortController().signal);
    await source.check!('b1', 'v', new AbortController().signal);
    expect(calls.map((c) => c.body)).toEqual([{ formVersionId: 'v1' }, { formVersionId: 'v1', value: 'v' }]);
    expect(calls.map((c) => c.url.split('/v1/p/staff')[1])).toEqual(['/fields/b1/options', '/fields/b1/check']);
    expect((calls[0]?.init.headers as Record<string, string>)['x-fr-access']).toBeUndefined();
  });

  it('a refusal or an answer that is not the contract is a RemoteFailed without the upstream text', async () => {
    stub(() => json(502, { code: 'REMOTE_UPSTREAM_FAILED', detail: 'secret.internal:8443 refused' }));
    await expect(proxySource(scope).lookup('hr', 'as', new AbortController().signal)).rejects.toBeInstanceOf(RemoteFailed);
    stub(() => json(200, { nope: true }));
    await expect(proxySource(scope).lookup('hr', 'as', new AbortController().signal)).rejects.toBeInstanceOf(RemoteFailed);
  });

  it('an aborted call stays an abort, so a superseded search is not reported as a failure', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))));
    controller.abort();
    await expect(proxySource(scope).lookup('hr', 'as', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('testRemote (the author route)', () => {
  it('sends only the keys the route accepts: itemsPath, mappings, inline auth and the rest of the draft stay out', () => {
    const request = testRequestOf({
      url: 'https://hr.example.com/d' as never,
      method: 'GET',
      credentialRef: { secretId: 's1' },
      searchParam: 'q',
      ...({ itemsPath: 'rows', mappings: [{ key: 'a' }], auth: { type: 'bearer', token: SECRET }, name: 'x' } as object),
    });
    expect(Object.keys(request).sort()).toEqual(['credentialRef', 'method', 'searchParam', 'url']);
    expect(JSON.stringify(request)).not.toContain(SECRET);
  });

  it('posts to the form route in the org and returns the parsed tree; any failure is RemoteFailed', async () => {
    stub(() => json(200, { status: 200, data: { a: 1 }, truncated: false }));
    const out = await testRemote('o1', 'f1', { url: 'https://x.example.com/' as never }, { q: 'ab' });
    expect(out.data).toEqual({ a: 1 });
    expect(calls[0]?.url).toMatch(/\/v1\/forms\/f1\/remote\/test$/);
    expect(calls[0]?.body).toEqual({ request: { url: 'https://x.example.com/' }, q: 'ab' });
    stub(() => json(502, { code: 'REMOTE_UPSTREAM_FAILED' }));
    await expect(testRemote('o1', 'f1', { url: 'https://x.example.com/' as never })).rejects.toBeInstanceOf(RemoteFailed);
  });
});

describe('api credentials client', () => {
  it('sends the secret once on create and no list call returns it', async () => {
    const view = { id: 'c1', name: 'HR', type: 'bearer', header: null, host: 'hr.example.com', last4: '', createdAt: 'x', rotatedAt: null };
    stub((_url, init) => (init.method === 'POST' ? json(201, view) : json(200, { items: [view] })));
    await addApiCredential('o1', { name: 'HR', host: 'hr.example.com', auth: { type: 'bearer', token: SECRET } });
    expect(JSON.stringify(calls[0]?.body)).toContain(SECRET);
    const listed = await listApiCredentials('o1');
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    expect(calls[1]?.init.method ?? 'GET').toBe('GET');
  });
});
