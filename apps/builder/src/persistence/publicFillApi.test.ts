import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicUnavailable, addressWithoutQuery, deviceOf, fetchPublicForm, originOf, submitPublicForm, unlockPublicForm, uuidv7 } from '@/persistence/publicFillApi';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => json(status, { type: 'about:blank', title: code, status, code, ...extra });

function stubFetch(answer: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(answer.clone());
    }),
  );
  return calls;
}

const BODY = { formVersionId: 'v1', answers: {}, fields: [], locale: 'en-IN', client: {} };

afterEach(() => vi.unstubAllGlobals());

describe('uuidv7', () => {
  it('is a version 7, variant 1 uuid whose first 48 bits are the clock', () => {
    const id = uuidv7(Date.UTC(2026, 10, 15, 4, 30), () => new Uint8Array(16).fill(0xff));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(Date.UTC(2026, 10, 15, 4, 30));
  });

  it('sorts by time and is different on every call', () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_800_000_000_000);
    expect(early < late).toBe(true);
    expect(uuidv7(1_700_000_000_000)).not.toBe(early);
  });
});

describe('what is kept of the page view', () => {
  it('the address loses its query and fragment, credentials and anything that is not http(s)', () => {
    expect(addressWithoutQuery('https://forms.example/f/feedback?utm=1&token=secret#top')).toBe('https://forms.example/f/feedback');
    expect(addressWithoutQuery('https://user:pw@forms.example:8443/f/x?a=b')).toBe('https://forms.example:8443/f/x');
    expect(addressWithoutQuery('javascript:alert(1)')).toBeUndefined();
    expect(addressWithoutQuery('not a url')).toBeUndefined();
    expect(addressWithoutQuery(undefined)).toBeUndefined();
  });

  it('the referrer is its site only', () => {
    expect(originOf('https://news.example/a/story?id=7')).toBe('https://news.example');
    expect(originOf('android-app://com.example')).toBeUndefined();
    expect(originOf('')).toBeUndefined();
  });

  it('the device is a class of the viewport width', () => {
    expect([1440, 1024, 1023, 640, 639, 360].map(deviceOf)).toEqual(['desktop', 'desktop', 'tablet', 'tablet', 'mobile', 'mobile']);
  });
});

describe('fetchPublicForm', () => {
  it('sends the access token as X-FR-Access, without credentials', async () => {
    const calls = stubFetch(problem(404, 'NOT_FOUND'));
    await expect(fetchPublicForm('feedback', 'tok')).resolves.toEqual({ kind: 'missing' });
    expect(calls[0]?.url).toBe('/v1/p/feedback');
    expect(calls[0]?.init).toMatchObject({ credentials: 'omit', headers: { accept: 'application/json', 'x-fr-access': 'tok' } });
    const without = stubFetch(problem(404, 'NOT_FOUND'));
    await fetchPublicForm('feedback', null);
    expect((without[0]?.init.headers as Record<string, string>)['x-fr-access']).toBeUndefined();
  });

  it('{ redirectTo } is a redirect; a 5xx or an answer that breaks the contract is unavailable', async () => {
    stubFetch(json(200, { redirectTo: 'new-name' }));
    await expect(fetchPublicForm('old', null)).resolves.toEqual({ kind: 'redirect', slug: 'new-name' });
    stubFetch(problem(503, 'SERVICE_UNAVAILABLE'));
    await expect(fetchPublicForm('old', null)).rejects.toBeInstanceOf(PublicUnavailable);
    stubFetch(json(200, { slug: 'x', formId: 'f', status: { state: 'nonsense' } }));
    await expect(fetchPublicForm('old', null)).rejects.toBeInstanceOf(PublicUnavailable);
  });

  it('a password form comes back with a status and no version', async () => {
    stubFetch(json(200, { slug: 'feedback', formId: 'f1', status: { state: 'password', screen: { type: 'doc', content: [] } } }));
    await expect(fetchPublicForm('feedback', null)).resolves.toMatchObject({ kind: 'form', status: { state: 'password' }, version: null });
  });
});

describe('unlockPublicForm', () => {
  it('posts the password, and answers the token; 401, 429 and 404 are told apart', async () => {
    const calls = stubFetch(json(200, { accessToken: 'tok', expiresAt: '2026-11-15T06:30:00.000Z' }));
    await expect(unlockPublicForm('feedback', 'pw')).resolves.toEqual({ kind: 'ok', accessToken: 'tok' });
    expect(calls[0]).toMatchObject({ url: '/v1/p/feedback/unlock', init: { method: 'POST', credentials: 'omit', body: JSON.stringify({ password: 'pw' }) } });
    stubFetch(problem(401, 'FORM_UNLOCK_FAILED'));
    await expect(unlockPublicForm('feedback', 'no')).resolves.toEqual({ kind: 'wrong' });
    stubFetch(problem(429, 'RATE_LIMITED'));
    await expect(unlockPublicForm('feedback', 'no')).resolves.toEqual({ kind: 'rate_limited' });
    stubFetch(problem(404, 'NOT_FOUND'));
    await expect(unlockPublicForm('feedback', 'no')).resolves.toEqual({ kind: 'missing' });
  });
});

describe('submitPublicForm', () => {
  it('sends the Idempotency-Key and the token, and answers what the server took', async () => {
    const calls = stubFetch(json(200, { ok: true, submissionId: 's1', endingId: 'e1' }));
    await expect(submitPublicForm('feedback', BODY, 'key-1', 'tok')).resolves.toEqual({ kind: 'ok', submissionId: 's1', endingId: 'e1' });
    expect(calls[0]).toMatchObject({ url: '/v1/p/feedback/submissions', init: { method: 'POST', credentials: 'omit', headers: { 'idempotency-key': 'key-1', 'x-fr-access': 'tok', 'content-type': 'application/json' } } });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(BODY);
  });

  it('tells each refusal the page can act on apart by its status and code', async () => {
    const cases: Array<[Response, unknown]> = [
      [problem(422, 'SUBMISSION_INVALID', { errors: [{ path: 'q.sub', message: 'Too short.' }, { path: 'x' }] }), { kind: 'invalid', errors: [{ path: 'q.sub', message: 'Too short.' }] }],
      [problem(422, 'IDEMPOTENCY_KEY_REUSED'), { kind: 'key_reused' }],
      [problem(409, 'VERSION_SUPERSEDED'), { kind: 'version_superseded' }],
      [problem(409, 'FORM_CLOSED'), { kind: 'closed' }],
      [problem(409, 'LIMIT_REACHED'), { kind: 'limit_reached' }],
      [problem(401, 'PASSWORD_REQUIRED'), { kind: 'password_required' }],
      [problem(429, 'RATE_LIMITED'), { kind: 'rate_limited' }],
      [problem(404, 'NOT_FOUND'), { kind: 'missing' }],
    ];
    for (const [answer, expected] of cases) {
      stubFetch(answer);
      await expect(submitPublicForm('feedback', BODY, 'k', null)).resolves.toEqual(expected);
    }
  });

  it('anything else throws, so the renderer offers a retry with the same key', async () => {
    stubFetch(problem(503, 'SERVICE_UNAVAILABLE'));
    await expect(submitPublicForm('feedback', BODY, 'k', null)).rejects.toBeInstanceOf(PublicUnavailable);
    stubFetch(problem(409, 'SOMETHING_NEW'));
    await expect(submitPublicForm('feedback', BODY, 'k', null)).rejects.toBeInstanceOf(PublicUnavailable);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    await expect(submitPublicForm('feedback', BODY, 'k', null)).rejects.toBeInstanceOf(TypeError);
  });
});
