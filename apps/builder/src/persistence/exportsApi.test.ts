import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import {
  ExportExpired,
  ExportFailed,
  ExportTimedOut,
  canExport,
  downloadExport,
  getExport,
  newIdempotencyKey,
  requestExport,
  runExport,
  saveFile,
  wait,
  type ExportState,
} from '@/persistence/exportsApi';

const ID = '0196f0a0-0000-7000-8000-0000000000e1';
const FORM = 'f1';

const state = (status: ExportState['status'], more: Partial<ExportState> = {}): ExportState => ({
  id: ID,
  formId: FORM,
  format: 'csv',
  scope: { kind: 'all' },
  includeSensitive: false,
  status,
  rowCount: status === 'ready' ? 3 : null,
  bytes: status === 'ready' ? 12 : null,
  error: null,
  createdAt: '2026-11-16T10:00:00.000Z',
  finishedAt: status === 'ready' ? '2026-11-16T10:00:05.000Z' : null,
  expiresAt: status === 'ready' ? '2026-11-17T10:00:05.000Z' : null,
  ...more,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => json(status, { type: 'about:blank', title: code, status, code, ...extra });
const file = (disposition: string | null = 'attachment; filename="Feedback-2026-11-16.csv"; filename*=UTF-8\'\'Feedback-2026-11-16.csv') =>
  new Response('name\nAsha\n', { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', ...(disposition ? { 'content-disposition': disposition } : {}) } });

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Stubs `fetch` with one answer per call, in order (an Error is a network failure), and returns the calls made. */
function script(answers: Array<Response | Error | (() => Response | Error)>) {
  const calls: Call[] = [];
  let at = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? 'GET', url, headers: (init.headers ?? {}) as Record<string, string>, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      const next = answers[at];
      at += 1;
      if (next === undefined) return Promise.reject(new Error(`unexpected call ${at}: ${init.method ?? 'GET'} ${url}`));
      const answer = typeof next === 'function' ? next() : next;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer.clone());
    }),
  );
  return calls;
}

/** A pause that does not wait, and remembers how long it was asked to. */
function pauses() {
  const asked: number[] = [];
  return { asked, sleep: (ms: number) => Promise.resolve(void asked.push(ms)) };
}

const NETWORK = () => new TypeError('Failed to fetch');
const run = (key = 'key-1', extra: Partial<Parameters<typeof runExport>[0]> = {}) =>
  runExport({ org: 'o1', formId: FORM, request: { format: 'csv', scope: { kind: 'all' } }, key, ...extra });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('canExport', () => {
  it('is true when the org grants submissions.export, false when it does not', async () => {
    const calls = script([json(200, { org: { id: 'o1' }, role: 'editor', permissions: ['forms.read', 'submissions.export'] })]);
    await expect(canExport('o1')).resolves.toBe(true);
    expect(calls[0]).toMatchObject({ method: 'GET', url: '/v1/org', headers: { 'x-fr-org': 'o1' } });
    script([json(200, { org: { id: 'o1' }, role: 'data_viewer', permissions: ['forms.read', 'submissions.read'] })]);
    await expect(canExport('o1')).resolves.toBe(false);
  });

  it('is an error, not a no, when the answer cannot be read', async () => {
    script([problem(500, 'INTERNAL')]);
    await expect(canExport('o1')).rejects.toBeInstanceOf(ApiProblem);
    script([json(200, { unexpected: true })]);
    await expect(canExport('o1')).rejects.toBeInstanceOf(ApiUnreachable);
  });
});

describe('requestExport and getExport', () => {
  it('post the request in the named org with the Idempotency-Key, and nothing else: a plain request is format and scope', async () => {
    const calls = script([json(200, state('queued'))]);
    await expect(requestExport('o1', FORM, { format: 'csv', scope: { kind: 'all' } }, 'key-1')).resolves.toMatchObject({ id: ID, status: 'queued' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/v1/forms/${FORM}/exports`,
      headers: { 'idempotency-key': 'key-1', 'x-fr-org': 'o1', 'x-fr-client': 'builder', 'content-type': 'application/json' },
      body: { format: 'csv', scope: { kind: 'all' } },
    });
    expect(Object.keys(calls[0]!.body as object)).toEqual(['format', 'scope']);
  });

  it('send the scope as chosen, and the sensitive option only with its trimmed reason', async () => {
    const calls = script([json(200, state('queued')), json(200, state('queued')), json(200, state('queued'))]);
    await requestExport('o1', FORM, { format: 'xlsx', scope: { kind: 'selected', ids: ['a', 'b'] } }, 'k1');
    await requestExport('o1', FORM, { format: 'csv', scope: { kind: 'filtered', from: '2026-11-01T00:00:00.000Z' }, includeSensitive: true, reason: '  DSR #12  ' }, 'k2');
    await requestExport('o1', FORM, { format: 'csv', scope: { kind: 'all' }, includeSensitive: false, reason: 'ignored' }, 'k3');
    expect(calls.map((c) => c.body)).toEqual([
      { format: 'xlsx', scope: { kind: 'selected', ids: ['a', 'b'] } },
      { format: 'csv', scope: { kind: 'filtered', from: '2026-11-01T00:00:00.000Z' }, includeSensitive: true, reason: 'DSR #12' },
      { format: 'csv', scope: { kind: 'all' } },
    ]);
  });

  it('read the export back, and refuse an answer that is not an export', async () => {
    const calls = script([json(200, state('running')), json(200, { id: ID })]);
    await expect(getExport('o1', ID)).resolves.toMatchObject({ status: 'running' });
    expect(calls[0]).toMatchObject({ method: 'GET', url: `/v1/exports/${ID}`, headers: { 'x-fr-org': 'o1' } });
    await expect(getExport('o1', ID)).rejects.toBeInstanceOf(ApiUnreachable);
  });

  it('say what the API refused with: its status and code', async () => {
    script([problem(403, 'FORBIDDEN'), problem(422, 'EXPORT_REASON_REQUIRED'), problem(429, 'EXPORT_QUOTA_REACHED')]);
    await expect(requestExport('o1', FORM, { format: 'csv', scope: { kind: 'all' } }, 'k')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(requestExport('o1', FORM, { format: 'csv', scope: { kind: 'all' } }, 'k')).rejects.toMatchObject({ status: 422, code: 'EXPORT_REASON_REQUIRED' });
    await expect(requestExport('o1', FORM, { format: 'csv', scope: { kind: 'all' } }, 'k')).rejects.toMatchObject({ status: 429, code: 'EXPORT_QUOTA_REACHED' });
  });
});

describe('runExport', () => {
  it('polls until the export is ready, stops there, and fetches the file through the API', async () => {
    const calls = script([json(200, state('queued')), json(200, state('running')), json(200, state('ready')), file()]);
    const wait = pauses();
    const seen: string[] = [];
    let downloading = 0;
    const out = await run('key-1', { sleep: wait.sleep, onState: (s) => seen.push(s.status), onDownloading: () => (downloading += 1) });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST /v1/forms/${FORM}/exports`, `GET /v1/exports/${ID}`, `GET /v1/exports/${ID}`, `GET /v1/exports/${ID}/download`]);
    // Two polls were waited for (the first pauses are short), and none after `ready`.
    expect(wait.asked).toEqual([1000, 1500]);
    expect(seen).toEqual(['queued', 'running', 'ready']);
    expect(downloading).toBe(1);
    expect(out.name).toBe('Feedback-2026-11-16.csv');
    expect(await out.blob.text()).toBe('name\nAsha\n');
    expect(calls[3]).toMatchObject({ headers: { 'x-fr-org': 'o1' } });
  });

  it('goes straight to the file when the first answer is already ready, without waiting', async () => {
    const calls = script([json(200, state('ready')), file(null)]);
    const wait = pauses();
    const out = await run('k', { sleep: wait.sleep });
    expect(calls).toHaveLength(2);
    expect(wait.asked).toEqual([]);
    // No filename from the server: the builder names it by the format.
    expect(out.name).toBe('responses.csv');
  });

  it('slows to every five seconds after the first few polls', async () => {
    script([json(200, state('queued')), ...Array.from({ length: 6 }, () => json(200, state('running'))), json(200, state('ready')), file()]);
    const wait = pauses();
    await run('k', { sleep: wait.sleep });
    expect(wait.asked).toEqual([1000, 1500, 2000, 3000, 5000, 5000, 5000]);
  });

  it('surfaces a failed export with the error the worker recorded, and fetches nothing', async () => {
    const calls = script([json(200, state('queued')), json(200, state('failed', { error: 'the file could not be written' }))]);
    const wait = pauses();
    const err = await run('k', { sleep: wait.sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportFailed);
    expect((err as ExportFailed).reason).toBe('the file could not be written');
    expect(calls.map((c) => c.url)).toEqual([`/v1/forms/${FORM}/exports`, `/v1/exports/${ID}`]);
  });

  it('surfaces an export that expired before it was fetched, and fetches nothing', async () => {
    const calls = script([json(200, state('queued')), json(200, state('expired'))]);
    await expect(run('k', { sleep: pauses().sleep })).rejects.toBeInstanceOf(ExportExpired);
    expect(calls).toHaveLength(2);
  });

  it('gives up waiting after ten minutes, and says the export carries on', async () => {
    script([json(200, state('queued')), ...Array.from({ length: 200 }, () => json(200, state('running')))]);
    const wait = pauses();
    await expect(run('k', { sleep: wait.sleep })).rejects.toBeInstanceOf(ExportTimedOut);
    expect(wait.asked.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('passes a refusal on as it is, without retrying it: a role without the permission, a quota', async () => {
    const calls = script([problem(429, 'EXPORT_QUOTA_REACHED')]);
    await expect(run('k', { sleep: pauses().sleep })).rejects.toMatchObject({ status: 429, code: 'EXPORT_QUOTA_REACHED' });
    expect(calls).toHaveLength(1);
    const forbidden = script([problem(403, 'FORBIDDEN')]);
    await expect(run('k', { sleep: pauses().sleep })).rejects.toMatchObject({ status: 403 });
    expect(forbidden).toHaveLength(1);
  });

  it('reports a file that cannot be fetched (not ready, gone) as the API refused it', async () => {
    script([json(200, state('ready')), problem(410, 'EXPORT_EXPIRED')]);
    await expect(run('k', { sleep: pauses().sleep })).rejects.toMatchObject({ status: 410, code: 'EXPORT_EXPIRED' });
  });
});

describe('the Idempotency-Key', () => {
  it('is one per action and the same on every retry of it: a lost answer, then a 503, then the export', async () => {
    const calls = script([NETWORK(), problem(503, 'SERVICE_UNAVAILABLE'), json(200, state('ready')), file()]);
    const wait = pauses();
    await run('action-key', { sleep: wait.sleep });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(3);
    expect(posts.map((c) => c.headers['idempotency-key'])).toEqual(['action-key', 'action-key', 'action-key']);
    // The same body each time, so the API finds the export it may already have made.
    expect(new Set(posts.map((c) => JSON.stringify(c.body))).size).toBe(1);
    expect(wait.asked).toEqual([500, 1000]);
  });

  it('is never reused by another action: each call to newIdempotencyKey is new, and two actions send two keys', async () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
    const [first, second] = [newIdempotencyKey(), newIdempotencyKey()];
    const calls = script([json(200, state('ready')), file(), json(200, state('ready', { id: 'other' })), file()]);
    await run(first, { sleep: pauses().sleep });
    await run(second, { sleep: pauses().sleep });
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.headers['idempotency-key'])).toEqual([first, second]);
  });

  it('stops retrying after three tries and says the API cannot be reached', async () => {
    const calls = script([NETWORK(), NETWORK(), NETWORK()]);
    await expect(run('k', { sleep: pauses().sleep })).rejects.toBeInstanceOf(ApiUnreachable);
    expect(calls).toHaveLength(3);
  });
});

describe('polling through a bad moment', () => {
  it('carries on after a poll that got no answer, and gives up after three in a row', async () => {
    script([json(200, state('queued')), NETWORK(), json(200, state('ready')), file()]);
    await expect(run('k', { sleep: pauses().sleep })).resolves.toMatchObject({ name: 'Feedback-2026-11-16.csv' });
    const calls = script([json(200, state('queued')), NETWORK(), NETWORK(), NETWORK()]);
    await expect(run('k', { sleep: pauses().sleep })).rejects.toBeInstanceOf(ApiUnreachable);
    expect(calls).toHaveLength(4);
    // A refusal is not a bad moment.
    const refused = script([json(200, state('queued')), problem(404, 'NOT_FOUND')]);
    await expect(run('k', { sleep: pauses().sleep })).rejects.toMatchObject({ status: 404 });
    expect(refused).toHaveLength(2);
  });

  it('stops at once when the signal aborts, with no further call', async () => {
    const controller = new AbortController();
    const calls = script([json(200, state('queued')), json(200, state('ready')), file()]);
    const sleep = (_ms: number, signal?: AbortSignal) => {
      controller.abort();
      return wait(10_000, signal);
    };
    await expect(run('k', { sleep, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(1);
  });
});

describe('wait', () => {
  it('resolves after the time, and rejects at once when aborted', async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      void wait(1000).then(done);
      await vi.advanceTimersByTimeAsync(999);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toHaveBeenCalled();
      const controller = new AbortController();
      const aborted = wait(60_000, controller.signal);
      controller.abort();
      await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
      await expect(wait(1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('downloadExport', () => {
  it('reads the name from Content-Disposition and the bytes as they are', async () => {
    script([new Response(new Uint8Array([0, 255, 128, 10]), { status: 200, headers: { 'content-disposition': 'attachment; filename="r.xlsx"' } })]);
    const out = await downloadExport('o1', ID, 'xlsx');
    expect(out.name).toBe('r.xlsx');
    expect(new Uint8Array(await out.blob.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128, 10]));
  });

  it('says what the API refused with, and is unreachable for an answer that is not a problem', async () => {
    script([problem(409, 'EXPORT_NOT_READY'), new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }), NETWORK()]);
    await expect(downloadExport('o1', ID, 'csv')).rejects.toMatchObject({ status: 409, code: 'EXPORT_NOT_READY' });
    await expect(downloadExport('o1', ID, 'csv')).rejects.toBeInstanceOf(ApiUnreachable);
    await expect(downloadExport('o1', ID, 'csv')).rejects.toBeInstanceOf(ApiUnreachable);
  });
});

describe('saveFile', () => {
  it('hands the browser the file through a blob link named as the server named it, and removes the link', () => {
    const created = vi.fn(() => 'blob:fake');
    const revoked = vi.fn();
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
    const clicked: Array<{ download: string; href: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href });
    });
    const blob = new Blob(['a,b']);
    saveFile({ blob, name: 'Feedback-2026-11-16.csv' });
    expect(created).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual([{ download: 'Feedback-2026-11-16.csv', href: 'blob:fake' }]);
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
