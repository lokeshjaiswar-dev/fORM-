import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { ApiProblem } from '@/auth/client';
import {
  MAX_BULK,
  PAGE_SIZE,
  bulkSubmissions,
  getRemoteSubmission,
  getSubmission,
  gridPath,
  listRemoteSubmissions,
  listSubmissions,
  patchSubmission,
} from '@/persistence/submissionsApi';

const api = vi.fn();
const orgApi = vi.fn();
let session: { status: string } = { status: 'signed_in' };

vi.mock('@/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/client')>();
  return {
    ...actual,
    api: (...args: unknown[]) => api(...args),
    orgApi: (...args: unknown[]) => orgApi(...args),
    ensureSession: () => Promise.resolve(session),
  };
});

const FORM = '0196f0a0-0000-7000-8000-000000000001';
const ROW = '0196f0a0-0000-7000-8000-0000000000aa';

const gridPage = {
  columns: [
    { id: 'b1', key: 'name', label: 'Name', type: 'short_text' },
    { id: 'b2', key: 'legacy', label: 'Legacy ref', type: 'short_text' },
  ],
  items: [
    {
      id: ROW,
      receivedAt: '2026-11-15T10:00:00.000Z',
      status: 'complete',
      read: false,
      starred: true,
      archivedAt: null,
      trashedAt: null,
      versionNumber: 2,
      cells: { b1: 'Asha' },
      masked: ['b3'],
      // The API may send more than the page reads: it is ignored, not refused.
      somethingNew: 1,
    },
  ],
  nextCursor: 'signed.cursor',
};

const detail = {
  id: ROW,
  formId: FORM,
  receivedAt: '2026-11-15T10:00:00.000Z',
  status: 'complete',
  read: false,
  starred: false,
  archivedAt: null,
  trashedAt: null,
  versionId: '0196f0a0-0000-7000-8000-0000000000bb',
  versionNumber: 2,
  locale: 'en-IN',
  meta: { locale: 'en-IN' },
  fields: [{ id: 'b1', key: 'name', label: 'Name', type: 'short_text', value: 'Asha', masked: false }],
  answers: { b1: { type: 'short_text', value: 'Asha' } },
  files: [
    { id: '0196f0a0-0000-7000-8000-0000000000cc', blockId: 'b4', name: 'cv.pdf', mime: 'application/pdf', sizeBytes: 1200, purpose: 'file', masked: false },
    { id: null, blockId: 'b5', name: '••••••', mime: '', sizeBytes: null, purpose: 'file', masked: true },
  ],
};

/** The schema a call passed to `orgApi`, which the real client parses the answer with. */
const schemaOfCall = (n = 0): z.ZodType => orgApi.mock.calls[n]?.[2] as z.ZodType;

describe('submissionsApi', () => {
  beforeEach(() => {
    orgApi.mockReset();
  });

  describe('gridPath', () => {
    const params = (query: Parameters<typeof gridPath>[1], cursor?: string | null) => new URL(gridPath(FORM, query, cursor), 'http://x').searchParams;

    it('asks for the folder and a page size, and leaves out every filter that is not set', () => {
      const url = new URL(gridPath(FORM, { view: 'inbox' }), 'http://x');
      expect(url.pathname).toBe(`/v1/forms/${FORM}/submissions`);
      expect([...url.searchParams.entries()]).toEqual([
        ['view', 'inbox'],
        ['limit', String(PAGE_SIZE)],
      ]);
    });

    it('sends the search words (trimmed), the dates, the flags, the status and the cursor as the API names them', () => {
      const p = params(
        { view: 'trash', q: '  ada  ', from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T23:59:59.999Z', read: false, starred: true, status: 'spam' },
        'signed.cursor',
      );
      expect(Object.fromEntries(p)).toEqual({
        view: 'trash',
        limit: String(PAGE_SIZE),
        q: 'ada',
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-02T23:59:59.999Z',
        read: 'false',
        starred: 'true',
        status: 'spam',
        cursor: 'signed.cursor',
      });
    });

    it('sends `read=true` and `starred=false` too: a flag that is set to false is still a filter', () => {
      const p = params({ view: 'archived', read: true, starred: false });
      expect(p.get('read')).toBe('true');
      expect(p.get('starred')).toBe('false');
    });

    it('treats a blank search as no search, and a null cursor as the first page', () => {
      const p = params({ view: 'inbox', q: '   ' }, null);
      expect(p.has('q')).toBe(false);
      expect(p.has('cursor')).toBe(false);
    });

    it('puts the form id in the path as one segment, never as more path', () => {
      expect(gridPath('a/b?c', { view: 'inbox' })).toMatch(/^\/v1\/forms\/a%2Fb%3Fc\/submissions\?/);
    });
  });

  describe('list', () => {
    it('reads a page through the org route (session and X-FR-Org), with the columns, rows and the next cursor', async () => {
      orgApi.mockResolvedValue(gridPage);
      await expect(listSubmissions(FORM, { view: 'inbox' }, 'c1')).resolves.toBe(gridPage);
      expect(orgApi).toHaveBeenCalledWith('GET', gridPath(FORM, { view: 'inbox' }, 'c1'), expect.anything());
      expect(gridPath(FORM, { view: 'inbox' }, 'c1')).toContain('cursor=c1');
    });

    it('parses the answer with a schema that keeps what the grid shows, and drops what it does not read', () => {
      void listSubmissions(FORM, { view: 'inbox' });
      const page = schemaOfCall().parse(gridPage) as typeof gridPage;
      expect(page.columns.map((c) => c.label)).toEqual(['Name', 'Legacy ref']);
      expect(page.items[0]).toMatchObject({ id: ROW, read: false, starred: true, cells: { b1: 'Asha' }, masked: ['b3'] });
      expect(page.items[0]).not.toHaveProperty('somethingNew');
      expect(page.nextCursor).toBe('signed.cursor');
    });

    it('accepts the last page (a null cursor) and a status this build does not know', () => {
      void listSubmissions(FORM, { view: 'inbox' });
      const parsed = schemaOfCall().parse({ ...gridPage, items: [{ ...gridPage.items[0], status: 'pending_review' }], nextCursor: null }) as typeof gridPage;
      expect(parsed.nextCursor).toBeNull();
      expect(parsed.items[0]?.status).toBe('pending_review');
    });

    it('refuses an answer that is not a grid page', () => {
      void listSubmissions(FORM, { view: 'inbox' });
      expect(schemaOfCall().safeParse({ items: [] }).success).toBe(false);
      expect(schemaOfCall().safeParse({ ...gridPage, items: [{ id: ROW }] }).success).toBe(false);
    });

    it('lets a refusal through, for the page to say so (it is not turned into an empty list)', async () => {
      orgApi.mockRejectedValue(new ApiProblem(403, 'FORBIDDEN', 'Requires submissions.read.'));
      await expect(listSubmissions(FORM, { view: 'inbox' })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    });
  });

  describe('detail', () => {
    it('reads one response through the org route', async () => {
      orgApi.mockResolvedValue(detail);
      await getSubmission(FORM, ROW);
      expect(orgApi).toHaveBeenCalledWith('GET', `/v1/forms/${FORM}/submissions/${ROW}`, expect.anything());
    });

    it('parses its fields and its files, including a protected file with no id', () => {
      void getSubmission(FORM, ROW);
      const parsed = schemaOfCall().parse(detail) as typeof detail;
      expect(parsed.fields[0]).toEqual({ id: 'b1', key: 'name', label: 'Name', type: 'short_text', value: 'Asha', masked: false });
      expect(parsed.files).toHaveLength(2);
      expect(parsed.files[1]).toMatchObject({ id: null, masked: true });
      // What the page does not show (the stored answers, the version id, what the server recorded) is not carried along.
      expect(parsed).not.toHaveProperty('answers');
      expect(parsed).not.toHaveProperty('meta');
    });
  });

  describe('patch', () => {
    it('sends only the flag it was given', async () => {
      orgApi.mockResolvedValue({ id: ROW, read: true, starred: false });
      await expect(patchSubmission(FORM, ROW, { read: true })).resolves.toEqual({ id: ROW, read: true, starred: false });
      expect(orgApi).toHaveBeenCalledWith('PATCH', `/v1/forms/${FORM}/submissions/${ROW}`, expect.anything(), { read: true });
    });

    it('can star and mark unread in one call, and reads back both flags', async () => {
      orgApi.mockResolvedValue({ id: ROW, read: false, starred: true });
      await patchSubmission(FORM, ROW, { read: false, starred: true });
      expect(orgApi.mock.calls[0]?.[3]).toEqual({ read: false, starred: true });
      expect(schemaOfCall().parse({ id: ROW, read: false, starred: true })).toEqual({ id: ROW, read: false, starred: true });
      expect(schemaOfCall().safeParse({ id: ROW, read: 'yes', starred: true }).success).toBe(false);
    });
  });

  describe('bulk', () => {
    const result = { action: 'trash', requested: 2, changed: 2, unchanged: 0, missing: 0, removedFiles: 0 };

    it('posts the action and the ids to the bulk route of the form', async () => {
      orgApi.mockResolvedValue(result);
      await expect(bulkSubmissions(FORM, 'trash', [ROW, 'second'])).resolves.toEqual(result);
      expect(orgApi).toHaveBeenCalledWith('POST', `/v1/forms/${FORM}/submissions/bulk`, expect.anything(), { action: 'trash', ids: [ROW, 'second'] });
    });

    it('parses the counts the API answers with, including the files a delete removed', () => {
      void bulkSubmissions(FORM, 'delete', [ROW]);
      expect(schemaOfCall().parse({ ...result, action: 'delete', removedFiles: 3 })).toMatchObject({ action: 'delete', removedFiles: 3 });
      expect(schemaOfCall().safeParse({ action: 'delete' }).success).toBe(false);
    });

    it('asks nothing for no ids, or for more than one call may name (the API would refuse it)', () => {
      expect(() => bulkSubmissions(FORM, 'trash', [])).toThrow(RangeError);
      expect(() => bulkSubmissions(FORM, 'trash', Array.from({ length: MAX_BULK + 1 }, (_, i) => `id${i}`))).toThrow(RangeError);
      expect(orgApi).not.toHaveBeenCalled();
      orgApi.mockResolvedValue(result);
      expect(() => bulkSubmissions(FORM, 'trash', Array.from({ length: MAX_BULK }, (_, i) => `id${i}`))).not.toThrow();
    });

    it('passes a refused delete on as it came (nothing was deleted), so the page can say why', async () => {
      orgApi.mockRejectedValue(new ApiProblem(409, 'SUBMISSION_NOT_TRASHED', 'Only responses in the trash can be deleted forever'));
      await expect(bulkSubmissions(FORM, 'delete', [ROW])).rejects.toMatchObject({ status: 409, code: 'SUBMISSION_NOT_TRASHED' });
    });
  });
});

describe('submissionsApi (the page’s earlier reads)', () => {
  beforeEach(() => {
    api.mockReset();
    orgApi.mockReset();
    session = { status: 'signed_in' };
  });

  it('lists the responses of a form in the active org, never on a public route', async () => {
    orgApi.mockResolvedValue({ items: [{ id: 's1', formId: 'f1', submittedAt: '2026-01-01T00:00:00.000Z', fieldCount: 2 }] });
    await expect(listRemoteSubmissions('f1')).resolves.toEqual([
      { id: 's1', formId: 'f1', submittedAt: '2026-01-01T00:00:00.000Z', fieldCount: 2 },
    ]);
    expect(orgApi).toHaveBeenCalledWith('GET', '/v1/forms/f1/submissions', expect.anything());
    expect(api).not.toHaveBeenCalled();
  });

  it('reads one response through the org route, marked as the server’s so its rows are shown as built there', async () => {
    const row = { id: 's1', formId: 'f1', submittedAt: '2026-01-01T00:00:00.000Z', answers: {}, fields: [] };
    orgApi.mockResolvedValue(row);
    await expect(getRemoteSubmission('f1', 's1')).resolves.toEqual({ ...row, source: 'server' });
    expect(orgApi).toHaveBeenCalledWith('GET', '/v1/forms/f1/submissions/s1', expect.anything());
    expect(api).not.toHaveBeenCalled();
  });

  it('asks the API nothing while signed out', async () => {
    session = { status: 'signed_out' };
    await expect(listRemoteSubmissions('f1')).resolves.toBeNull();
    await expect(getRemoteSubmission('f1', 's1')).resolves.toBeNull();
    expect(orgApi).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });

  it('treats a refusal as no remote responses', async () => {
    orgApi.mockRejectedValue(new Error('forbidden'));
    await expect(listRemoteSubmissions('f1')).resolves.toBeNull();
  });
});
