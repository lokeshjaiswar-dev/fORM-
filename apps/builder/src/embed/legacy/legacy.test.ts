import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DmsAuthError, createDmsClient } from '@/embed/dmsClient';
import { currentLaunch, decodeDescriptor, encodeDescriptor, rememberMasterId, resetLaunchMemo, type LaunchDescriptor } from '@/embed/launch';
import { startLaunch } from '@/embed/session/launchFlow';
import { testEnv } from '@/embed/session/testing';
import { readDmsToken } from './cookieToken';
import { validateDescriptor } from './descriptor';

/*
 * The M2 build (VITE_FP_LEGACY_DESCRIPTOR=1): a `#fp=` launch still works, with the user's own DMS token and the old transport. These
 * are the former tests of `launch.ts` and `dmsClient.ts`, now on the modules that hold that code. In a default build none of it exists.
 */

const ORIGIN = 'https://dms.example.test';
const LEGACY = { ...testEnv(`${ORIGIN}/api`), legacyDescriptor: true };
const MASTER = 'a1000000-0000-4000-8000-000000000001';
const policy = { origin: ORIGIN, returnOrigins: [] as string[], apiBases: [`${ORIGIN}/api`] };

const descriptor = (over: Partial<LaunchDescriptor> = {}): LaunchDescriptor => ({
  v: 1,
  mode: 'dms-master',
  profile: 'dms-v1',
  tenantId: 'acme',
  workspaceId: 'ws_1',
  master: { name: 'Vendor', doctypeIds: [], folderIds: [] },
  returnUrl: `${ORIGIN}/dms-v2/acme/metadata`,
  apiBase: `${ORIGIN}/api/`,
  ...over,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const at = (d: LaunchDescriptor) => window.history.replaceState(null, '', `/embed/dms-master#fp=${encodeDescriptor(d)}`);

beforeEach(() => {
  resetLaunchMemo();
  vi.stubEnv('VITE_FP_LEGACY_DESCRIPTOR', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetLaunchMemo();
  document.cookie.split('; ').forEach((c) => {
    document.cookie = `${c.split('=')[0]}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
  localStorage.clear();
});

describe('validateDescriptor', () => {
  it('accepts a good descriptor and normalises the API base (no trailing slash) and the return URL', () => {
    expect(validateDescriptor(descriptor(), 'dms-master', policy)).toMatchObject({ ok: true, launch: { apiBase: `${ORIGIN}/api`, returnUrl: `${ORIGIN}/dms-v2/acme/metadata`, tenantId: 'acme', profile: 'dms-v1' } });
  });
  it('accepts a root-relative API base (the dev rewrite on the DMS host)', () => {
    expect(validateDescriptor(descriptor({ apiBase: '/api' }), 'dms-master', policy)).toMatchObject({ ok: true, launch: { apiBase: `${ORIGIN}/api` } });
  });
  it('refuses a descriptor for another mode, another profile, another version, or with extra keys', () => {
    expect(validateDescriptor(descriptor({ mode: 'dms-record' }), 'dms-master', policy)).toMatchObject({ ok: false, reason: 'wrong_mode' });
    for (const bad of [{ ...descriptor(), profile: 'full' }, { ...descriptor(), v: 2 }, { ...descriptor(), token: 'x' }, 'nope']) {
      expect(validateDescriptor(bad, 'dms-master', policy)).toMatchObject({ ok: false, reason: 'invalid' });
    }
  });
  it('refuses ids that could smuggle characters into a header, and a masterId that is not a uuid', () => {
    expect(validateDescriptor(descriptor({ tenantId: 'a\r\nX-Evil: 1' }), 'dms-master', policy).ok).toBe(false);
    expect(validateDescriptor(descriptor({ workspaceId: '' }), 'dms-master', policy).ok).toBe(false);
    expect(validateDescriptor(descriptor({ masterId: '1; drop' }), 'dms-master', policy).ok).toBe(false);
    expect(validateDescriptor(descriptor({ masterId: MASTER }), 'dms-master', policy).ok).toBe(true);
  });
  it('the apiBase is matched exactly: another origin, another path, a query, userinfo and other schemes are refused', () => {
    for (const apiBase of ['https://evil.example.test/api', `${ORIGIN}/files/public/x`, `${ORIGIN}/api/sub`, `${ORIGIN}/api?x=1`, 'javascript:alert(1)', 'ftp://dms.example.test/api', 'https://user:pw@dms.example.test/api', '//evil.example.test/api', 'https://dms.example.test.evil.test/api']) {
      expect(validateDescriptor(descriptor({ apiBase }), 'dms-master', policy)).toMatchObject({ ok: false, reason: 'api_origin_rejected' });
    }
    expect(validateDescriptor(descriptor(), 'dms-master', { ...policy, apiBases: [] })).toMatchObject({ ok: false, reason: 'api_origin_rejected' });
  });
  it('a classification other than null is invalid (the link does not choose it); null is fine', () => {
    expect(validateDescriptor({ ...descriptor(), master: { name: 'V', doctypeIds: [], folderIds: [], classification: 'confidential' } }, 'dms-master', policy)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(validateDescriptor({ ...descriptor(), master: { name: 'V', doctypeIds: [], folderIds: [], classification: null } }, 'dms-master', policy)).toMatchObject({ ok: true });
  });
  it.each(['https://evil.example.test/', 'javascript:alert(1)', 'data:text/html,x', 'https://user:pw@dms.example.test/x', '//evil.example.test/x', 'not a url'])('drops the return URL %s to null and still opens', (returnUrl) => {
    expect(validateDescriptor(descriptor({ returnUrl }), 'dms-master', policy)).toMatchObject({ ok: true, launch: { returnUrl: null } });
  });
});

describe('the M2 launch flow', () => {
  it('a #fp= launch opens with the legacy transport: the user\'s token from the cookie, X-Tenant-Id and X-Workspace-Id, the legacy path', async () => {
    document.cookie = 'token=Bearer%20cookie-token; path=/';
    at(descriptor());
    const fetch = vi.fn().mockResolvedValue(json(200, { success: true }));
    expect(await startLaunch('dms-master', { env: LEGACY, fetch: fetch as never })).toEqual({ kind: 'legacy' });
    expect(window.location.hash).toBe('');
    const launch = currentLaunch('dms-master');
    expect(launch).toMatchObject({ ok: true, launch: { tenantId: 'acme', workspaceId: 'ws_1', apiBase: `${ORIGIN}/api` } });
    await createDmsClient({ apiBase: `${ORIGIN}/api`, tenantId: 'acme', workspaceId: 'ws_1', fetch: fetch as never }).request('POST', '/dms/v1/master/form', { a: 1 });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(`${ORIGIN}/api/dms/v1/master/form`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(init.headers).toEqual({ Authorization: 'Bearer cookie-token', 'X-Tenant-Id': 'acme', 'X-Workspace-Id': 'ws_1', Accept: 'application/json', 'Content-Type': 'application/json' });
  });

  it('refuses a bad descriptor with the old reasons, and makes no request', async () => {
    at(descriptor({ apiBase: 'https://evil.example.test/api' }));
    const fetch = vi.fn();
    expect(await startLaunch('dms-master', { env: LEGACY, fetch: fetch as never })).toEqual({ kind: 'failed', reason: 'api_not_allowed' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the descriptor for a reload of this tab and re-validates it (storage is untrusted too)', async () => {
    at(descriptor());
    await startLaunch('dms-master', { env: LEGACY, fetch: vi.fn() as never });
    const kept = sessionStorage.getItem('fp.launch.dms-master')!;
    resetLaunchMemo();
    sessionStorage.setItem('fp.launch.dms-master', kept);
    expect(await startLaunch('dms-master', { env: LEGACY, fetch: vi.fn() as never })).toEqual({ kind: 'legacy' });
    resetLaunchMemo();
    sessionStorage.setItem('fp.launch.dms-master', encodeDescriptor(descriptor({ apiBase: 'https://evil.example.test/api' })));
    expect(await startLaunch('dms-master', { env: LEGACY, fetch: vi.fn() as never })).toEqual({ kind: 'failed', reason: 'api_not_allowed' });
  });

  it('after a create the kept launch and the stored descriptor say "edit that master", so a reload never creates twice', async () => {
    at(descriptor());
    await startLaunch('dms-master', { env: LEGACY, fetch: vi.fn() as never });
    rememberMasterId('dms-master', MASTER);
    expect(currentLaunch('dms-master')).toMatchObject({ ok: true, launch: { masterId: MASTER } });
    expect((decodeDescriptor(sessionStorage.getItem('fp.launch.dms-master')!) as LaunchDescriptor).masterId).toBe(MASTER);
  });

  it('no token: no request (there is no fallback)', async () => {
    at(descriptor());
    const fetch = vi.fn();
    await startLaunch('dms-master', { env: LEGACY, fetch: fetch as never });
    await expect(createDmsClient({ apiBase: `${ORIGIN}/api`, tenantId: 'acme', workspaceId: 'ws_1', fetch: fetch as never }).request('GET', '/dms/masters/x')).rejects.toBeInstanceOf(DmsAuthError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('with no fragment and no stored descriptor the M2 build says the page was not opened from DMS', async () => {
    window.history.replaceState(null, '', '/embed/dms-master');
    expect(await startLaunch('dms-master', { env: LEGACY, fetch: vi.fn() as never })).toEqual({ kind: 'failed', reason: 'missing' });
  });
});

describe('readDmsToken (the cookie reader, M2 only)', () => {
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
