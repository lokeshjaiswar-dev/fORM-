import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewGroupId, ReviewSettings, ReviewUnitId } from '@form/schema';
import { ApiUnreachable } from '@/auth/client';
import { ReviewConflict, ReviewInvalid, getReviewSettings, inputOf, saveReviewSettings } from '@/persistence/reviewApi';

const VIEW = {
  rev: 4,
  enabled: true,
  distinctCheckers: false,
  units: [{ unitId: 'u1', groupId: '01970000-0000-7000-8000-0000000000a1', order: 1, required: true, visibility: 'own_unit' }],
};

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

const SETTINGS: ReviewSettings = inputOf(VIEW as unknown as Parameters<typeof inputOf>[0]);

afterEach(() => vi.unstubAllGlobals());

describe('reviewApi', () => {
  it('reads the settings in the named org', async () => {
    const calls = stubFetch(json(200, VIEW));
    await expect(getReviewSettings('o1', 'f1')).resolves.toEqual(VIEW);
    expect(calls[0]).toMatchObject({ url: '/v1/forms/f1/review', method: 'GET', headers: { 'x-fr-org': 'o1' } });
  });

  it('puts the form id in the path as one segment, whatever it holds', async () => {
    const calls = stubFetch(json(200, VIEW));
    await getReviewSettings('o1', 'a/b?c');
    expect(calls[0]?.url).toBe('/v1/forms/a%2Fb%3Fc/review');
  });

  it('sends the settings with If-Match = the revision that was read, and answers the saved settings with their new revision', async () => {
    const calls = stubFetch(json(200, { ...VIEW, rev: 5, enabled: false }));
    const saved = await saveReviewSettings('o1', 'f1', { ...SETTINGS, enabled: false }, 4);
    expect(saved).toMatchObject({ rev: 5, enabled: false });
    expect(calls[0]).toMatchObject({
      url: '/v1/forms/f1/review',
      method: 'PUT',
      headers: { 'if-match': '"4"', 'x-fr-org': 'o1', 'x-fr-client': 'builder' },
      body: { enabled: false, distinctCheckers: false, units: SETTINGS.units },
    });
    // The revision is the server's to count: it is not part of what is sent.
    expect(calls[0]?.body).not.toHaveProperty('rev');
  });

  it('a stale revision (409 REVIEW_SETTINGS_CONFLICT) surfaces as a ReviewConflict the tab turns into a reload prompt', async () => {
    stubFetch(problem(409, 'REVIEW_SETTINGS_CONFLICT', { detail: 'The review settings changed since you read them.' }));
    const err = await saveReviewSettings('o1', 'f1', SETTINGS, 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewConflict);
    expect((err as ReviewConflict).message).toBe('The review settings changed since they were read.');
  });

  it('refused values are a ReviewInvalid with the field paths; any other refusal stays a problem with its status and code', async () => {
    stubFetch(problem(400, 'VALIDATION_FAILED', { detail: 'bad', errors: [{ path: 'body/units/0/groupId', message: 'no such review group' }, { nope: true }] }));
    const err = await saveReviewSettings('o1', 'f1', SETTINGS, 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewInvalid);
    expect((err as ReviewInvalid).fields).toEqual([{ path: 'body/units/0/groupId', message: 'no such review group' }]);

    stubFetch(problem(403, 'FORBIDDEN'));
    await expect(saveReviewSettings('o1', 'f1', SETTINGS, 3)).rejects.toMatchObject({ name: 'ApiProblem', status: 403, code: 'FORBIDDEN' });
    // A 409 that is not this conflict is not read as one.
    stubFetch(problem(409, 'DRAFT_REV_CONFLICT'));
    await expect(saveReviewSettings('o1', 'f1', SETTINGS, 3)).rejects.toMatchObject({ name: 'ApiProblem', status: 409, code: 'DRAFT_REV_CONFLICT' });
  });

  it('a form that is not on the server is a 404 problem the tab recognises', async () => {
    stubFetch(problem(404, 'NOT_FOUND', { detail: 'That form is not in this organisation.' }));
    await expect(getReviewSettings('o1', 'f1')).rejects.toMatchObject({ name: 'ApiProblem', status: 404 });
  });

  it('an answer that is not the settings, or not JSON at all, is an unreachable API', async () => {
    stubFetch(json(200, { rev: 'four' }));
    await expect(getReviewSettings('o1', 'f1')).rejects.toBeInstanceOf(ApiUnreachable);
    stubFetch(new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    await expect(getReviewSettings('o1', 'f1')).rejects.toBeInstanceOf(ApiUnreachable);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    await expect(saveReviewSettings('o1', 'f1', SETTINGS, 1)).rejects.toBeInstanceOf(ApiUnreachable);
  });

  it('ignores keys it does not know, as the other form APIs do', async () => {
    stubFetch(json(200, { ...VIEW, updatedAt: '2026-11-16T00:00:00Z' }));
    await expect(getReviewSettings('o1', 'f1')).resolves.toEqual(VIEW);
  });

  it('inputOf drops the revision', () => {
    expect(SETTINGS).toEqual({ enabled: true, distinctCheckers: false, units: [{ unitId: 'u1' as ReviewUnitId, groupId: '01970000-0000-7000-8000-0000000000a1' as ReviewGroupId, order: 1, required: true, visibility: 'own_unit' }] });
  });
});
