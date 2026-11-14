import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '@/auth/client';
import { loadSubmissionFile, publicUploader } from '@/persistence/filesApi';

const orgBlob = vi.fn();
const getLocal = vi.fn();
let session: { status: string } = { status: 'signed_in' };

vi.mock('@/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/client')>();
  return { ...actual, orgBlob: (...args: unknown[]) => orgBlob(...args), ensureSession: () => Promise.resolve(session) };
});

vi.mock('@/persistence/blobStore', () => ({ getSubmissionFile: (...args: unknown[]) => getLocal(...args) }));

const REF = { fileId: '0b9c1f5e-3d1a-4a64-9d51-0d1d3b2f6a10', name: 'a.txt', sizeBytes: 3, mime: 'text/plain', sha256: 'a'.repeat(64), scan: 'skipped' };

beforeEach(() => {
  orgBlob.mockReset();
  getLocal.mockReset();
  getLocal.mockResolvedValue(undefined);
  session = { status: 'signed_in' };
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

describe('loadSubmissionFile', () => {
  it('opens a preview file this browser made without asking the API', async () => {
    const blob = new Blob(['local']);
    getLocal.mockResolvedValue({ blob, name: 'a.txt', mime: 'text/plain' });
    await expect(loadSubmissionFile('f1', 'x')).resolves.toEqual({ blob, name: 'a.txt', mime: 'text/plain' });
    expect(orgBlob).not.toHaveBeenCalled();
  });

  it('downloads a respondent’s file through the org route and keeps nothing in the browser', async () => {
    const blob = new Blob(['remote'], { type: 'image/png' });
    orgBlob.mockResolvedValue(blob);
    await expect(loadSubmissionFile('f1', 'file-1')).resolves.toMatchObject({ blob, mime: 'image/png' });
    expect(orgBlob).toHaveBeenCalledWith('/v1/forms/f1/files/file-1');
  });

  it('shows nothing, and asks nothing, while signed out', async () => {
    session = { status: 'signed_out' };
    await expect(loadSubmissionFile('f1', 'file-1')).resolves.toBeUndefined();
    expect(orgBlob).not.toHaveBeenCalled();
  });

  it('shows nothing when the API refuses', async () => {
    orgBlob.mockRejectedValue(new ApiProblem(404, 'NOT_FOUND', 'That file is not on this form.'));
    await expect(loadSubmissionFile('f1', 'file-1')).resolves.toBeUndefined();
  });
});
