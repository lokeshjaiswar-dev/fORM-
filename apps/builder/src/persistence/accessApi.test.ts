import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiUnreachable } from '@/auth/client';
import {
  AccessConflict,
  AccessInvalid,
  SlugTaken,
  changeSlug,
  getAccess,
  getOrgTimeZone,
  getSlugs,
  inputOf,
  removeFormPassword,
  saveAccess,
  setFormPassword,
} from '@/persistence/accessApi';

const VIEW = { rev: 4, enabled: true, hasPassword: true, passwordUpdatedAt: '2026-11-01T00:00:00.000Z', embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72 };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => json(status, { type: 'about:blank', title: code, status, code, ...extra });

/** Stubs `fetch` to answer `answer`, and returns what the calls were. */
function stubFetch(answer: Response | (() => Response)) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      return Promise.resolve(typeof answer === 'function' ? answer() : answer.clone());
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('accessApi', () => {
  it('reads the settings in the named org', async () => {
    const calls = stubFetch(json(200, VIEW));
    await expect(getAccess('o1', 'f1')).resolves.toEqual(VIEW);
    expect(calls[0]).toMatchObject({ url: '/v1/forms/f1/access', method: 'GET', headers: { 'x-fr-org': 'o1' } });
  });

  it('saves with If-Match = the revision that was read, and sends the settings as the body', async () => {
    const calls = stubFetch(json(200, { ...VIEW, rev: 5, submissionLimit: 100 }));
    const input = { enabled: true, submissionLimit: 100, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72 };
    await expect(saveAccess('o1', 'f1', input, 4)).resolves.toMatchObject({ rev: 5, submissionLimit: 100 });
    expect(calls[0]).toMatchObject({ url: '/v1/forms/f1/access', method: 'PUT', headers: { 'if-match': '"4"', 'x-fr-org': 'o1', 'x-fr-client': 'builder' }, body: input });
  });

  it('a stale revision (409 ACCESS_REV_CONFLICT) is an AccessConflict; refused values are an AccessInvalid with their paths', async () => {
    stubFetch(problem(409, 'ACCESS_REV_CONFLICT'));
    await expect(saveAccess('o1', 'f1', inputOf(VIEW), 3)).rejects.toBeInstanceOf(AccessConflict);
    stubFetch(problem(400, 'VALIDATION_FAILED', { detail: 'bad', errors: [{ path: 'closeAt', message: 'must be after openAt' }, { nope: true }] }));
    const err = await saveAccess('o1', 'f1', inputOf(VIEW), 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessInvalid);
    expect((err as AccessInvalid).fields).toEqual([{ path: 'closeAt', message: 'must be after openAt' }]);
    // Any other refusal stays a problem with its status and code.
    stubFetch(problem(403, 'FORBIDDEN'));
    await expect(saveAccess('o1', 'f1', inputOf(VIEW), 3)).rejects.toMatchObject({ name: 'ApiProblem', status: 403, code: 'FORBIDDEN' });
  });

  it('sets and removes the password; the answer only says whether one is set', async () => {
    const calls = stubFetch(json(200, { hasPassword: true }));
    await setFormPassword('o1', 'f1', 'violet-anchor-teapot-91');
    expect(calls[0]).toMatchObject({ url: '/v1/forms/f1/access/password', method: 'PUT', body: { password: 'violet-anchor-teapot-91' } });
    const removed = stubFetch(json(200, { hasPassword: false }));
    await removeFormPassword('o1', 'f1');
    expect(removed[0]).toMatchObject({ url: '/v1/forms/f1/access/password', method: 'DELETE' });
    stubFetch(problem(422, 'WEAK_PASSWORD', { detail: 'Choose a longer password.' }));
    await expect(setFormPassword('o1', 'f1', 'abc')).rejects.toMatchObject({ status: 422, code: 'WEAK_PASSWORD', message: 'Choose a longer password.' });
  });

  it('a slug another form holds (409 FORM_SLUG_TAKEN) is SlugTaken; a free one answers the addresses', async () => {
    stubFetch(problem(409, 'FORM_SLUG_TAKEN'));
    await expect(changeSlug('o1', 'f1', 'taken')).rejects.toBeInstanceOf(SlugTaken);
    const calls = stubFetch(json(200, { slug: 'new-name', previousSlugs: ['old-name'] }));
    await expect(changeSlug('o1', 'f1', 'new-name')).resolves.toEqual({ slug: 'new-name', previousSlugs: ['old-name'] });
    expect(calls[0]).toMatchObject({ url: '/v1/forms/f1/slug', method: 'PUT', body: { slug: 'new-name' } });
    stubFetch(json(200, { slug: null, previousSlugs: [] }));
    await expect(getSlugs('o1', 'f1')).resolves.toEqual({ slug: null, previousSlugs: [] });
  });

  it('reads the org time zone from GET /v1/org', async () => {
    const calls = stubFetch(json(200, { org: { id: 'o1', timeZone: 'Asia/Kolkata' }, role: 'owner', permissions: [] }));
    await expect(getOrgTimeZone('o1')).resolves.toBe('Asia/Kolkata');
    expect(calls[0]?.url).toBe('/v1/org');
  });

  it('an answer that is not the settings, or no answer at all, is an unreachable API', async () => {
    stubFetch(json(200, { nothing: 'useful' }));
    await expect(getAccess('o1', 'f1')).rejects.toBeInstanceOf(ApiUnreachable);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    await expect(getAccess('o1', 'f1')).rejects.toBeInstanceOf(ApiUnreachable);
  });

  it('inputOf is the settings without the revision and the password state', () => {
    expect(inputOf(VIEW)).toEqual({ enabled: true, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72 });
  });
});
