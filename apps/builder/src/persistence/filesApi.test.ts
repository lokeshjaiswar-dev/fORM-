import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadName, loadSubmissionFile, publicUploader } from '@/persistence/filesApi';

const getLocal = vi.fn();
let session: { status: string; me?: unknown } = { status: 'signed_in', me: { orgs: [{ id: 'org-1' }], activeOrgId: 'org-1' } };

vi.mock('@/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/client')>();
  return { ...actual, ensureSession: () => Promise.resolve(session) };
});

vi.mock('@/persistence/blobStore', () => ({ getSubmissionFile: (...args: unknown[]) => getLocal(...args) }));

const REF = { fileId: '0b9c1f5e-3d1a-4a64-9d51-0d1d3b2f6a10', name: 'a.txt', sizeBytes: 3, mime: 'text/plain', sha256: 'a'.repeat(64), scan: 'skipped' };
const download = (body: BlobPart, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });

beforeEach(() => {
  getLocal.mockReset();
  getLocal.mockResolvedValue(undefined);
  session = { status: 'signed_in', me: { orgs: [{ id: 'org-1' }], activeOrgId: 'org-1' } };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('publicUploader', () => {
  it('posts the file to the form’s own upload route, naming the field, with no client id, and never the session cookie', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(REF), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const ref = await publicUploader('hello-1234')({ blockId: 'cv' as never, purpose: 'file', file: new Blob(['abc'], { type: 'text/plain' }), name: 'a.txt' });
    expect(ref).toEqual(REF);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/p\/hello-1234\/files$/);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ blockId: 'cv', purpose: 'file', name: 'a.txt', mime: 'text/plain', data: btoa('abc') });
    expect(body).not.toHaveProperty('id');
  });

  it('fails when the server refuses the file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 415 })));
    await expect(publicUploader('hello')({ blockId: 'cv' as never, purpose: 'file', file: new Blob(['x']), name: 'x.html' })).rejects.toThrow('file upload failed');
  });
});

describe('downloadName', () => {
  it('prefers the full RFC 5987 name, and falls back to the quoted one', () => {
    expect(downloadName(`attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`)).toBe('résumé.pdf');
    expect(downloadName('attachment; filename="plain.pdf"')).toBe('plain.pdf');
    expect(downloadName(null)).toBeUndefined();
    expect(downloadName('inline')).toBeUndefined();
  });

  it('only ever names a file, never a path or a control character', () => {
    expect(downloadName(`attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd`)).toBe('passwd');
    expect(downloadName(`attachment; filename="C:\\Users\\a\\evil.exe"`)).toBe('evil.exe');
    expect(downloadName(`attachment; filename*=UTF-8''a%00b%0D%0Ac.pdf`)).toBe('abc.pdf');
    expect(downloadName(`attachment; filename*=UTF-8''%E0%A4%A`)).toBeUndefined();
  });
});

describe('loadSubmissionFile', () => {
  it('opens a preview file this browser made without asking the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const blob = new Blob(['local']);
    getLocal.mockResolvedValue({ blob, name: 'a.txt', mime: 'text/plain' });
    await expect(loadSubmissionFile('f1', 'x')).resolves.toEqual({ blob, name: 'a.txt', mime: 'text/plain' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads a respondent’s file through the org route, named by the server, and keeps nothing in the browser', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      download('remote', { headers: { 'content-type': 'image/png', 'content-disposition': `attachment; filename="notes.txt"; filename*=UTF-8''notes.txt` } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const row = await loadSubmissionFile('f1', 'file-1');
    expect(row).toMatchObject({ name: 'notes.txt', mime: 'image/png' });
    expect(await row!.blob.text()).toBe('remote');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/forms\/f1\/files\/file-1$/);
    expect(init).toMatchObject({ method: 'GET', credentials: 'include', headers: { 'x-fr-org': 'org-1' } });
  });

  it('names a file "file" when the server names none, never after the answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(download(new Blob(['x']))));
    await expect(loadSubmissionFile('f1', 'file-1')).resolves.toMatchObject({ name: 'file' });
  });

  it('shows nothing, and asks nothing, while signed out', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    session = { status: 'signed_out' };
    await expect(loadSubmissionFile('f1', 'file-1')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows nothing when the API refuses or cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    await expect(loadSubmissionFile('f1', 'file-1')).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
    await expect(loadSubmissionFile('f1', 'file-1')).resolves.toBeUndefined();
  });
});
