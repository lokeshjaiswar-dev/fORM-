import { vi } from 'vitest';

/*
 * A stand-in for the forms routes of the API (apps/api/src/routes/forms.ts), for the forms list's component tests: the
 * list with search, sort, the starred filter, the lifecycle folders and a cursor bound to its query (a cursor taken to
 * another query is refused, as the real one is), and the verbs star, clone, archive, trash and restore. The real
 * routes are proved in apps/api (forms.int.test.ts); this keeps the page's tests about what the page does with them.
 */

export interface FakeForm {
  id: string;
  title: string;
  lifecycle: 'active' | 'archived' | 'trashed';
  createdAt: string;
  updatedAt: string;
  favourite: boolean;
  submissionCount: number;
  isLive: boolean;
}

export const fakeForm = (id: string, patch: Partial<FakeForm> = {}): FakeForm => ({
  id,
  title: `Form ${id}`,
  lifecycle: 'active',
  createdAt: '2026-11-01T04:30:00.000Z',
  updatedAt: '2026-11-10T04:30:00.000Z',
  favourite: false,
  submissionCount: 0,
  isLive: false,
  ...patch,
});

export interface FakeCall {
  method: string;
  path: string;
  query: URLSearchParams;
  org: string | null;
  csrf: string | null;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (status: number, code: string, detail: string) => new Response(JSON.stringify({ code, title: detail, detail, status }), { status, headers: { 'content-type': 'application/problem+json' } });

export interface FakeFormsApi {
  forms: Map<string, FakeForm>;
  calls: FakeCall[];
  /** The list calls only, newest last. */
  lists: () => FakeCall[];
  /** Refuse the next call to `METHOD /path` with this status (and an API-style problem). */
  refuse: (method: string, path: RegExp, status: number, detail?: string) => void;
  /** Hold every answer back until `release()`: for the moments in between. */
  hold: () => { release: () => void };
}

/** Installs the fake as the global `fetch` and returns its handles. Unknown routes answer 404, as an unrouted path does. */
export function installFormsApi(initial: FakeForm[]): FakeFormsApi {
  const forms = new Map(initial.map((form) => [form.id, { ...form }]));
  const calls: FakeCall[] = [];
  const refusals: Array<{ method: string; path: RegExp; status: number; detail: string }> = [];
  let gate: Promise<void> | null = null;
  let copies = 0;

  const sorted = (rows: FakeForm[], sort: string) =>
    [...rows].sort((a, b) => {
      if (sort === 'title') return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : a.title.toLowerCase() > b.title.toLowerCase() ? 1 : 0;
      const key = sort === 'created' ? 'createdAt' : 'updatedAt';
      return a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : a.id < b.id ? 1 : -1;
    });

  function list(query: URLSearchParams): Response {
    const lifecycle = query.get('lifecycle') ?? 'active';
    const sort = query.get('sort') ?? 'updated';
    const q = (query.get('q') ?? '').toLowerCase();
    const limit = Number(query.get('limit') ?? 50);
    // The cursor carries the query it was made for, so it is only good for that query.
    const scope = [...query.entries()].filter(([name]) => name !== 'cursor').map(([name, value]) => `${name}=${value}`).join('&');
    let offset = 0;
    const cursor = query.get('cursor');
    if (cursor !== null) {
      const [at, bound] = cursor.split('|');
      if (bound !== scope) return problem(400, 'INVALID_CURSOR', 'That cursor does not belong to this query.');
      offset = Number(at);
    }
    const rows = sorted(
      [...forms.values()].filter((form) => form.lifecycle === lifecycle && (!q || form.title.toLowerCase().includes(q)) && (query.get('favourite') !== 'true' || form.favourite)),
      sort,
    );
    const page = rows.slice(offset, offset + limit);
    return json(200, { items: page, nextCursor: offset + limit < rows.length ? `${offset + limit}|${scope}` : null });
  }

  function verb(method: string, id: string, action: string): Response {
    const form = forms.get(id);
    if (!form) return problem(404, 'NOT_FOUND', 'That form is not in this organisation.');
    if (action === 'favourite') {
      form.favourite = method === 'PUT';
      return json(200, { favourite: form.favourite });
    }
    if (action === 'clone') {
      copies += 1;
      const copy = fakeForm(`copy-${copies}`, { title: `Copy of ${form.title}`, updatedAt: '2026-11-15T04:30:00.000Z' });
      forms.set(copy.id, copy);
      return json(201, copy);
    }
    if (action === 'archive') {
      if (form.lifecycle === 'trashed') return problem(409, 'INVALID_STATE', 'A trashed form cannot be archived.');
      form.lifecycle = 'archived';
    } else if (action === 'trash') form.lifecycle = 'trashed';
    else if (action === 'restore') form.lifecycle = 'active';
    else return problem(404, 'NOT_FOUND', 'No such route.');
    return json(200, form);
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const [path = '', search = ''] = String(url).split('?');
      const headers = new Headers(init?.headers);
      calls.push({ method, path, query: new URLSearchParams(search), org: headers.get('x-fr-org'), csrf: headers.get('x-fr-client') });
      if (gate) await gate;
      const refused = refusals.findIndex((r) => r.method === method && r.path.test(path));
      if (refused >= 0) {
        const [r] = refusals.splice(refused, 1);
        return problem(r?.status ?? 500, r?.status === 403 ? 'FORBIDDEN' : 'FAILED', r?.detail ?? '');
      }
      if (method === 'GET' && path === '/v1/forms') return list(new URLSearchParams(search));
      const match = /^\/v1\/forms\/([^/]+)\/(favourite|clone|archive|trash|restore)$/.exec(path);
      return match ? verb(method, decodeURIComponent(match[1] ?? ''), match[2] ?? '') : problem(404, 'NOT_FOUND', 'No such route.');
    }),
  );

  return {
    forms,
    calls,
    lists: () => calls.filter((call) => call.method === 'GET' && call.path === '/v1/forms'),
    refuse: (method, path, status, detail = '') => void refusals.push({ method, path, status, detail }),
    hold: () => {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return { release };
    },
  };
}
