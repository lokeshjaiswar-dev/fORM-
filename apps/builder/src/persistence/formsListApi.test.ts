import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { PAGE_SIZE, archiveForm, cloneForm, fetchFormsPage, pageQuery, restoreForm, setFavourite, type FormsQuery } from '@/persistence/formsListApi';

const ORG = 'org-1';
const ROW = { id: 'f1', title: 'Feedback', lifecycle: 'active', teamId: 't1', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', favourite: true, submissionCount: 4, isLive: false };
const QUERY: FormsQuery = { lifecycle: 'active', q: '', sort: 'updated', favourite: false };

const reply = (status: number, body: unknown, type = 'application/json') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

function stub(answer: Response) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(answer));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const sent = (fetchMock: ReturnType<typeof stub>) => {
  const [url, init] = fetchMock.mock.calls[0] ?? ['', {}];
  return { url: String(url), method: init?.method, headers: new Headers(init?.headers), body: init?.body };
};

afterEach(() => vi.unstubAllGlobals());

describe('pageQuery', () => {
  it('asks for one page of the chosen folder in the chosen order, and nothing else by default', () => {
    expect(Object.fromEntries(new URLSearchParams(pageQuery(QUERY, null)))).toEqual({ limit: String(PAGE_SIZE), lifecycle: 'active', sort: 'updated' });
    expect(Object.fromEntries(new URLSearchParams(pageQuery({ ...QUERY, lifecycle: 'trashed', sort: 'title' }, null)))).toMatchObject({ lifecycle: 'trashed', sort: 'title' });
  });

  it('sends the search trimmed and no longer than the API accepts, and leaves it out when empty', () => {
    expect(new URLSearchParams(pageQuery({ ...QUERY, q: '  invoice  ' }, null)).get('q')).toBe('invoice');
    expect(new URLSearchParams(pageQuery({ ...QUERY, q: 'x'.repeat(300) }, null)).get('q')).toHaveLength(100);
    expect(new URLSearchParams(pageQuery({ ...QUERY, q: '   ' }, null)).has('q')).toBe(false);
  });

  it('sends the starred filter only when it is on (the API treats only "true" as a filter), and the cursor as it came', () => {
    expect(new URLSearchParams(pageQuery({ ...QUERY, favourite: true }, null)).get('favourite')).toBe('true');
    expect(new URLSearchParams(pageQuery(QUERY, null)).has('favourite')).toBe(false);
    expect(new URLSearchParams(pageQuery(QUERY, 'a+b/c=')).get('cursor')).toBe('a+b/c=');
    expect(pageQuery(QUERY, 'a+b/c=')).toContain('cursor=a%2Bb%2Fc%3D');
  });

  it('puts words that mean something to a URL (& = # %) in the value, not in the query', () => {
    const query = pageQuery({ ...QUERY, q: 'a&sort=title#x%' }, null);
    expect(new URLSearchParams(query).get('q')).toBe('a&sort=title#x%');
    expect(new URLSearchParams(query).get('sort')).toBe('updated');
  });
});

describe('fetchFormsPage', () => {
  it('reads a page as the signed-in member of the named org, with the session cookie and no CSRF header on a read', async () => {
    const fetchMock = stub(reply(200, { items: [ROW], nextCursor: 'next' }));
    const page = await fetchFormsPage(ORG, QUERY);
    expect(page).toEqual({ items: [{ id: 'f1', title: 'Feedback', lifecycle: 'active', createdAt: ROW.createdAt, updatedAt: ROW.updatedAt, favourite: true, submissionCount: 4, isLive: false }], nextCursor: 'next' });
    const call = sent(fetchMock);
    expect(call.url).toMatch(/\/v1\/forms\?limit=50&lifecycle=active&sort=updated$/);
    expect(call.method).toBe('GET');
    expect(call.headers.get('x-fr-org')).toBe(ORG);
    expect(call.headers.has('x-fr-client')).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' });
  });

  it('sends the cursor of the page before it', async () => {
    const fetchMock = stub(reply(200, { items: [], nextCursor: null }));
    await fetchFormsPage(ORG, QUERY, 'abc.def');
    expect(sent(fetchMock).url).toContain('cursor=abc.def');
  });

  it('a refusal is an ApiProblem with the API’s code and sentence', async () => {
    stub(reply(400, { code: 'INVALID_CURSOR', title: 'Bad cursor', detail: 'That cursor is not valid for this list.' }, 'application/problem+json'));
    await expect(fetchFormsPage(ORG, QUERY, 'x')).rejects.toMatchObject({ name: 'ApiProblem', status: 400, code: 'INVALID_CURSOR', message: 'That cursor is not valid for this list.' });
  });

  it('an answer the page cannot read is an unreachable API, never half a list', async () => {
    stub(reply(200, { items: [{ id: 'f1' }], nextCursor: null }));
    await expect(fetchFormsPage(ORG, QUERY)).rejects.toBeInstanceOf(ApiUnreachable);
    stub(reply(200, { items: [{ ...ROW, lifecycle: 'deleted' }], nextCursor: null }));
    await expect(fetchFormsPage(ORG, QUERY)).rejects.toBeInstanceOf(ApiUnreachable);
  });

  it('nothing answering is an unreachable API', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(fetchFormsPage(ORG, QUERY)).rejects.toBeInstanceOf(ApiUnreachable);
  });
});

describe('the one-form verbs', () => {
  it('PUT stars and DELETE unstars, in the named org and with the CSRF header', async () => {
    const put = stub(reply(200, { favourite: true }));
    await expect(setFavourite(ORG, 'f 1', true)).resolves.toBe(true);
    expect(sent(put)).toMatchObject({ method: 'PUT', url: expect.stringMatching(/\/v1\/forms\/f%201\/favourite$/) });
    expect(sent(put).headers.get('x-fr-client')).toBe('builder');
    expect(sent(put).headers.get('x-fr-org')).toBe(ORG);

    const del = stub(reply(200, { favourite: false }));
    await expect(setFavourite(ORG, 'f1', false)).resolves.toBe(false);
    expect(sent(del).method).toBe('DELETE');
    expect(sent(del).headers.get('x-fr-client')).toBe('builder');
  });

  it('clone, archive and restore POST to the form’s own route and answer the form as the API now holds it', async () => {
    for (const [call, path, status, lifecycle] of [
      [cloneForm, 'clone', 201, 'active'],
      [archiveForm, 'archive', 200, 'archived'],
      [restoreForm, 'restore', 200, 'active'],
    ] as const) {
      const fetchMock = stub(reply(status, { ...ROW, lifecycle }));
      const row = await call(ORG, 'f1');
      expect(row.lifecycle).toBe(lifecycle);
      expect(sent(fetchMock)).toMatchObject({ method: 'POST', url: expect.stringMatching(new RegExp(`/v1/forms/f1/${path}$`)) });
      expect(sent(fetchMock).headers.get('x-fr-client')).toBe('builder');
    }
  });

  it('a form the API does not have is an ApiProblem 404, a trashed form that cannot be archived a 409', async () => {
    stub(reply(404, { code: 'NOT_FOUND', title: 'Not found', detail: 'That form is not in this organisation.' }, 'application/problem+json'));
    await expect(archiveForm(ORG, 'nope')).rejects.toBeInstanceOf(ApiProblem);
    stub(reply(409, { code: 'INVALID_STATE', title: 'Conflict', detail: 'A trashed form cannot be archived.' }, 'application/problem+json'));
    await expect(archiveForm(ORG, 'f1')).rejects.toMatchObject({ status: 409 });
  });
});
