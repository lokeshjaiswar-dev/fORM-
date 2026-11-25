import { afterEach, describe, expect, it, vi } from 'vitest';
import { DmsApiError, DmsAuthError, createDmsClient, readDmsToken } from '@/embed/dmsClient';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const base = { apiBase: 'https://dms.example.test/api', tenantId: 'acme', workspaceId: 'ws_1' };

afterEach(() => {
  document.cookie.split('; ').forEach((c) => {
    document.cookie = `${c.split('=')[0]}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
  localStorage.clear();
  vi.useRealTimers();
});

describe('readDmsToken', () => {
  it('reads the cookies the DMS frontends set, then localStorage, and strips Bearer and quotes', () => {
    expect(readDmsToken()).toBeNull();
    localStorage.setItem('token', '"ls-token"');
    expect(readDmsToken()).toBe('ls-token');
    document.cookie = 'token=Bearer%20cookie-token; path=/';
    expect(readDmsToken()).toBe('cookie-token');
    document.cookie = 'Authorization=Bearer%20auth-token; path=/';
    expect(readDmsToken()).toBe('auth-token');
  });
  it('ignores "undefined", "null" and blanks', () => {
    localStorage.setItem('token', 'undefined');
    expect(readDmsToken()).toBeNull();
    localStorage.setItem('token', '  ');
    expect(readDmsToken()).toBeNull();
  });
});

describe('createDmsClient', () => {
  it('sends the token, tenant and workspace as headers to apiBase + path, without cookies or a referrer', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { success: true }));
    const client = createDmsClient({ ...base, fetch, token: () => 'tok' });
    await client.request('POST', '/dms/v1/master/form', { a: 1 });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://dms.example.test/api/dms/v1/master/form');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', body: '{"a":1}' });
    expect(init.headers).toEqual({ Authorization: 'Bearer tok', 'X-Tenant-Id': 'acme', 'X-Workspace-Id': 'ws_1', Accept: 'application/json', 'Content-Type': 'application/json' });
  });

  it("never follows a redirect (the bearer must not travel on to another place)", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, {}));
    await createDmsClient({ ...base, fetch, token: () => 'tok' }).request('GET', '/x');
    expect((fetch.mock.calls[0]![1] as RequestInit).redirect).toBe('error');
  });

  it('sends no body and no content type on a GET', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, {}));
    await createDmsClient({ ...base, fetch, token: () => 'tok' }).request('GET', '/x');
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(init).not.toHaveProperty('body');
    expect(init.headers).not.toHaveProperty('Content-Type');
  });

  it('makes no request at all without a token (there is no fallback token)', async () => {
    const fetch = vi.fn();
    await expect(createDmsClient({ ...base, fetch, token: () => null }).request('GET', '/x')).rejects.toBeInstanceOf(DmsAuthError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns a 401 into a sign-in error', async () => {
    const fetch = vi.fn().mockResolvedValue(json(401, { message: 'Unauthenticated.' }));
    await expect(createDmsClient({ ...base, fetch, token: () => 't' }).request('GET', '/x')).rejects.toBeInstanceOf(DmsAuthError);
  });

  it('keeps status, code and message of an error answer', async () => {
    const fetch = vi.fn().mockResolvedValue(json(409, { success: false, message: 'Master changed.', code: 'MASTER_CHANGED' }));
    const err = await createDmsClient({ ...base, fetch, token: () => 't' }).request('PATCH', '/x', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DmsApiError);
    expect(err).toMatchObject({ status: 409, code: 'MASTER_CHANGED', message: 'Master changed.' });
  });

  it('reads the first validation message, and copes with an empty or non-JSON body', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(422, { message: 'The given data was invalid.', errors: { 'form_builder_fields.0.name': ['The name is too long.'] } }))
      .mockResolvedValueOnce(json(422, { errors: { name: ['Name is required.'] } }))
      .mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    const client = createDmsClient({ ...base, fetch, token: () => 't' });
    expect(await client.request('POST', '/x', {}).catch((e: Error) => e.message)).toBe('The given data was invalid. The name is too long.');
    expect(await client.request('POST', '/x', {}).catch((e: Error) => e.message)).toBe('Name is required.');
    expect(await client.request('POST', '/x', {}).catch((e: Error) => e.message)).toBe('DMS answered 502.');
    expect(await client.request('POST', '/x', {}).catch((e: Error) => e.message)).toBe('DMS answered 500.');
  });

  it('says so when DMS cannot be reached, and when it does not answer in time', async () => {
    const down = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createDmsClient({ ...base, fetch: down, token: () => 't' }).request('GET', '/x')).rejects.toThrow(/cannot be reached \(Failed to fetch\)/);
    vi.useFakeTimers();
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
    const pending = createDmsClient({ ...base, fetch: hang as unknown as typeof fetch, token: () => 't' }).request('GET', '/x');
    const assertion = expect(pending).rejects.toThrow(/did not answer in time/);
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
  });
});
