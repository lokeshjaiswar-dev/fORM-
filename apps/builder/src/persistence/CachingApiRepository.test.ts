import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { CachingApiRepository } from '@/persistence/CachingApiRepository';
import { DraftConflict, type StoredForm } from '@/persistence/DocumentRepository';
import { newStoredForm } from '@/persistence/openForm';
import { MemoryRepository, block, formWith } from '@/test/fixtures';

const listRemoteForms = vi.fn();
const getRemoteDraft = vi.fn();
const putRemoteDraft = vi.fn();
const createRemoteForm = vi.fn();
const trashRemoteForm = vi.fn();

vi.mock('@/persistence/draftsApi', () => ({
  listRemoteForms: (...args: unknown[]) => listRemoteForms(...args),
  getRemoteDraft: (...args: unknown[]) => getRemoteDraft(...args),
  putRemoteDraft: (...args: unknown[]) => putRemoteDraft(...args),
  createRemoteForm: (...args: unknown[]) => createRemoteForm(...args),
  trashRemoteForm: (...args: unknown[]) => trashRemoteForm(...args),
}));

const NOW = '2026-10-19T04:30:00.000Z';
const LATER = '2026-10-19T05:00:00.000Z';
const ORG = 'org-1';

const server = (draftRev: number, title = 'Server') => ({
  draftRev,
  schemaVersion: 2,
  draft: { ...formWith([]), formId: 'f1', title },
  updatedAt: LATER,
  updatedBy: 'u2',
});

/** A cached form: `serverRev` is what the server held when it was last in step, `dirty` whether it holds unsent changes (a save sends it unless it says `false`). */
const cached = (patch: Partial<StoredForm>): StoredForm => ({
  ...newStoredForm('f1', NOW, { ...formWith([]), title: 'Mine' }),
  serverRev: 3,
  ...patch,
});

describe('CachingApiRepository', () => {
  beforeEach(() => {
    listRemoteForms.mockReset().mockResolvedValue(null);
    getRemoteDraft.mockReset().mockResolvedValue(null);
    putRemoteDraft.mockReset().mockResolvedValue({ draftRev: 4, updatedAt: LATER });
    createRemoteForm.mockReset().mockResolvedValue(undefined);
    trashRemoteForm.mockReset().mockResolvedValue(undefined);
  });

  describe('load', () => {
    it('prefers a higher server draftRev over a clean cache, keeps the local ops and caches the server draft', async () => {
      const cache = new MemoryRepository();
      const local = cached({ serverRev: 3, dirty: false, ops: { open: false, closedMessage: { type: 'doc', content: [] }, password: '' } });
      await cache.save(local);
      getRemoteDraft.mockResolvedValue(server(5));
      const loaded = await new CachingApiRepository(cache, ORG).load('f1');
      expect(loaded).toMatchObject({ serverRev: 5, dirty: false, doc: { title: 'Server' }, ops: local.ops });
      expect(getRemoteDraft).toHaveBeenCalledWith(ORG, 'f1');
      expect(await cache.load('f1')).toMatchObject({ serverRev: 5, dirty: false, doc: { title: 'Server' } });
    });

    it('raises DraftConflict for a dirty cache that is behind the server, with both sides and nothing overwritten', async () => {
      const cache = new MemoryRepository();
      const local = cached({ serverRev: 3, dirty: true });
      await cache.save(local);
      getRemoteDraft.mockResolvedValue(server(5));
      const error = await new CachingApiRepository(cache, ORG).load('f1').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DraftConflict);
      expect((error as DraftConflict).server).toMatchObject({ draftRev: 5, draft: { title: 'Server' } });
      expect((error as DraftConflict).local).toMatchObject({ serverRev: 3, dirty: true, doc: { title: 'Mine' } });
      expect(await cache.load('f1')).toMatchObject({ doc: { title: 'Mine' }, dirty: true });
    });

    it('is not a conflict when the dirty cache already is the server draft (a first push whose answer was lost)', async () => {
      const cache = new MemoryRepository();
      const local = cached({ serverRev: 0, dirty: true, doc: { ...formWith([]), formId: 'f1', title: 'Same' } });
      await cache.save(local);
      getRemoteDraft.mockResolvedValue(server(1, 'Same'));
      const loaded = await new CachingApiRepository(cache, ORG).load('f1');
      expect(loaded).toMatchObject({ serverRev: 1, dirty: false, doc: { title: 'Same' } });
      expect(await cache.load('f1')).toMatchObject({ serverRev: 1, dirty: false });
    });

    it('keeps the cached copy when the server is at the revision it was saved against, dirty or not', async () => {
      const cache = new MemoryRepository();
      await cache.save(cached({ serverRev: 5, dirty: true }));
      getRemoteDraft.mockResolvedValue(server(5));
      expect(await new CachingApiRepository(cache, ORG).load('f1')).toMatchObject({ doc: { title: 'Mine' }, serverRev: 5, dirty: true });
    });

    it('returns the cached copy offline, and the form with no cache from the server', async () => {
      const cache = new MemoryRepository();
      await cache.save(cached({}));
      expect(await new CachingApiRepository(cache, ORG).load('f1')).toMatchObject({ doc: { title: 'Mine' } });
      expect(await new CachingApiRepository(new MemoryRepository(), ORG).load('f1')).toBeNull();
      getRemoteDraft.mockResolvedValue(server(2));
      expect(await new CachingApiRepository(new MemoryRepository(), ORG).load('f1')).toMatchObject({ serverRev: 2, dirty: false, doc: { title: 'Server' } });
    });

    it('says why a form cannot be opened when the server fails and nothing is cached (and opens the cached copy when there is one)', async () => {
      getRemoteDraft.mockRejectedValue(new ApiProblem(500, 'INTERNAL', 'broken'));
      await expect(new CachingApiRepository(new MemoryRepository(), ORG).load('f1')).rejects.toThrow('broken');
      const cache = new MemoryRepository();
      await cache.save(cached({}));
      expect(await new CachingApiRepository(cache, ORG).load('f1')).toMatchObject({ doc: { title: 'Mine' } });
    });
  });

  describe('save', () => {
    it('writes the cache at once, then sends the draft with the server revision and marks the cache clean at the new one', async () => {
      const cache = new MemoryRepository();
      const repo = new CachingApiRepository(cache, ORG);
      const form = cached({ serverRev: 3, dirty: undefined });
      const result = await repo.save(form);
      expect(putRemoteDraft).toHaveBeenCalledWith(ORG, 'f1', form.doc, 3);
      expect(createRemoteForm).not.toHaveBeenCalled();
      expect(result).toEqual({ serverRev: 4, synced: true });
      expect(await cache.load('f1')).toMatchObject({ serverRev: 4, dirty: false, doc: { title: 'Mine' } });
    });

    it('creates the form row first when the server has not seen the form, and sends If-Match 0', async () => {
      const cache = new MemoryRepository();
      const form = newStoredForm('f1', NOW, { ...formWith([]), title: 'Hello' });
      putRemoteDraft.mockResolvedValue({ draftRev: 1, updatedAt: LATER });
      await new CachingApiRepository(cache, ORG).save(form);
      expect(createRemoteForm).toHaveBeenCalledWith(ORG, 'f1', 'Hello');
      expect(putRemoteDraft).toHaveBeenCalledWith(ORG, 'f1', form.doc, 0);
      expect(await cache.load('f1')).toMatchObject({ serverRev: 1, dirty: false });
    });

    it('keeps the change in the cache, dirty, when the server cannot be reached', async () => {
      putRemoteDraft.mockRejectedValue(new ApiUnreachable());
      const cache = new MemoryRepository();
      const result = await new CachingApiRepository(cache, ORG).save(cached({ serverRev: 3 }));
      expect(result).toEqual({ serverRev: 3, synced: false });
      expect(await cache.load('f1')).toMatchObject({ serverRev: 3, dirty: true, doc: { title: 'Mine' } });
    });

    it('maps a 409 to DraftConflict with the server draft and my copy, and leaves my copy dirty', async () => {
      putRemoteDraft.mockRejectedValue(new DraftConflict({ draftRev: 7, draft: { title: 'Theirs' }, updatedAt: LATER }));
      const cache = new MemoryRepository();
      const error = await new CachingApiRepository(cache, ORG).save(cached({ serverRev: 3 })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DraftConflict);
      expect((error as DraftConflict).server.draftRev).toBe(7);
      expect((error as DraftConflict).local).toMatchObject({ doc: { title: 'Mine' }, serverRev: 3 });
      expect(await cache.load('f1')).toMatchObject({ dirty: true, serverRev: 3 });
    });

    it('surfaces other refusals as save errors, and still has the change in the cache', async () => {
      putRemoteDraft.mockRejectedValue(new ApiProblem(422, 'DRAFT_INVALID', 'The draft is not valid.'));
      const cache = new MemoryRepository();
      await expect(new CachingApiRepository(cache, ORG).save(cached({ serverRev: 3 }))).rejects.toThrow('The draft is not valid.');
      expect(await cache.load('f1')).toMatchObject({ dirty: true });
    });

    it('sends nothing for a form read from the server and saved as it came (a merge result)', async () => {
      const cache = new MemoryRepository();
      const result = await new CachingApiRepository(cache, ORG).save(cached({ serverRev: 2, dirty: false }));
      expect(result).toEqual({ serverRev: 2, synced: true });
      expect(putRemoteDraft).not.toHaveBeenCalled();
      expect(await cache.load('f1')).toMatchObject({ serverRev: 2, dirty: false });
    });

    it('does not mark the cache clean over a newer local write made while the server was answering', async () => {
      const cache = new MemoryRepository();
      const repo = new CachingApiRepository(cache, ORG);
      let answer: (value: { draftRev: number; updatedAt: string }) => void = () => undefined;
      putRemoteDraft.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      const sent = repo.save(cached({ serverRev: 3, doc: { ...formWith([]), formId: 'f1', title: 'First' } }));
      await vi.waitFor(() => expect(putRemoteDraft).toHaveBeenCalled());
      await repo.saveLocal({ ...cached({ serverRev: 3 }), doc: { ...formWith([]), formId: 'f1', title: 'Second' } });
      answer({ draftRev: 4, updatedAt: LATER });
      await sent;
      expect(await cache.load('f1')).toMatchObject({ dirty: true, doc: { title: 'Second' } });
    });
  });

  describe('saveLocal', () => {
    it('writes the cache only, marked dirty, with no call to the server', async () => {
      const cache = new MemoryRepository();
      await new CachingApiRepository(cache, ORG).saveLocal(cached({ serverRev: 3, dirty: false }));
      expect(await cache.load('f1')).toMatchObject({ serverRev: 3, dirty: true });
      expect(putRemoteDraft).not.toHaveBeenCalled();
      expect(createRemoteForm).not.toHaveBeenCalled();
    });
  });

  describe('plaintext password (BL-145)', () => {
    it('never reaches the cache while signed in, on any write', async () => {
      const cache = new MemoryRepository();
      const repo = new CachingApiRepository(cache, ORG);
      const ops = { open: true, closedMessage: { type: 'doc', content: [] }, password: 'hunter2' };
      await repo.saveLocal(cached({ ops }));
      expect(JSON.stringify(await cache.load('f1'))).not.toContain('hunter2');
      await repo.save(cached({ ops }));
      expect(JSON.stringify(await cache.load('f1'))).not.toContain('hunter2');
      expect((await cache.load('f1'))?.ops).toMatchObject({ open: true, password: '' });
    });

    it('a password the server has not taken yet waits in ops.pendingAccess, which every write keeps (the first edit must not drop it)', async () => {
      const cache = new MemoryRepository();
      const repo = new CachingApiRepository(cache, ORG);
      const ops = { pendingAccess: { password: 'hunter2', closed: true } };
      await repo.saveLocal(cached({ ops }));
      expect((await cache.load('f1'))?.ops).toEqual(ops);
      await repo.save(cached({ ops }));
      expect((await cache.load('f1'))?.ops).toEqual(ops);
      await repo.adopt('f1', { draftRev: 9, draft: { ...formWith([]), title: 'Theirs' }, updatedAt: LATER });
      expect((await cache.load('f1'))?.ops).toEqual(ops);
    });
  });

  describe('adopt', () => {
    it('replaces the cached document with the server draft, clean, keeping the local ops', async () => {
      const cache = new MemoryRepository();
      const ops = { open: false, closedMessage: { type: 'doc', content: [] }, password: '' };
      await cache.save(cached({ dirty: true, ops }));
      await new CachingApiRepository(cache, ORG).adopt('f1', { draftRev: 9, draft: { ...formWith([]), title: 'Theirs' }, updatedAt: LATER });
      expect(await cache.load('f1')).toMatchObject({ serverRev: 9, dirty: false, doc: { title: 'Theirs' }, ops });
    });
  });

  describe('list', () => {
    it('lists remote forms that are not in this browser yet', async () => {
      listRemoteForms.mockResolvedValue({ items: [{ id: 'remote', title: 'From API', updatedAt: LATER }], complete: true });
      const repo = new CachingApiRepository(new MemoryRepository(), ORG);
      expect(await repo.list()).toEqual([{ id: 'remote', title: 'From API', savedAt: LATER, blocks: 0 }]);
      expect(listRemoteForms).toHaveBeenCalledWith(ORG);
    });

    it('hides a form the server knew and no longer lists (trashed elsewhere), but keeps one that never reached it', async () => {
      const cache = new MemoryRepository();
      await cache.save({ ...newStoredForm('synced', NOW), serverRev: 2, dirty: false });
      await cache.save({ ...newStoredForm('local-only', NOW), serverRev: 0, dirty: true });
      listRemoteForms.mockResolvedValue({ items: [], complete: true });
      expect((await new CachingApiRepository(cache, ORG).list()).map((f) => f.id)).toEqual(['local-only']);
    });

    it('trusts a truncated server list only for what it shows', async () => {
      const cache = new MemoryRepository();
      await cache.save({ ...newStoredForm('synced', NOW), serverRev: 2, dirty: false });
      listRemoteForms.mockResolvedValue({ items: [], complete: false });
      expect((await new CachingApiRepository(cache, ORG).list()).map((f) => f.id)).toEqual(['synced']);
    });

    it('lists what is cached when the server cannot be reached', async () => {
      const cache = new MemoryRepository();
      await cache.save(newStoredForm('a', NOW));
      listRemoteForms.mockRejectedValue(new ApiUnreachable());
      expect((await new CachingApiRepository(cache, ORG).list()).map((f) => f.id)).toEqual(['a']);
    });
  });

  describe('remove', () => {
    it('moves the form to the server trash and drops the cached copy; a form the server never had is only dropped', async () => {
      const cache = new MemoryRepository();
      await cache.save(newStoredForm('a', NOW));
      await new CachingApiRepository(cache, ORG).remove('a');
      expect(trashRemoteForm).toHaveBeenCalledWith(ORG, 'a');
      expect(await cache.load('a')).toBeNull();

      await cache.save(newStoredForm('b', NOW));
      trashRemoteForm.mockRejectedValue(new ApiProblem(404, 'NOT_FOUND', 'not here'));
      await new CachingApiRepository(cache, ORG).remove('b');
      expect(await cache.load('b')).toBeNull();
    });

    it('keeps the cached copy when the trash call fails, so nothing looks deleted that is not', async () => {
      const cache = new MemoryRepository();
      await cache.save(newStoredForm('a', NOW));
      trashRemoteForm.mockRejectedValue(new ApiUnreachable());
      await expect(new CachingApiRepository(cache, ORG).remove('a')).rejects.toBeInstanceOf(ApiUnreachable);
      expect(await cache.load('a')).not.toBeNull();
    });
  });

  it('cache summaries carry the server revision, which is how list knows a form was synced', async () => {
    const cache = new MemoryRepository();
    await cache.save({ ...newStoredForm('a', NOW, formWith([block('short_text', 'q')])), serverRev: 4, dirty: false });
    expect(await cache.list()).toMatchObject([{ id: 'a', blocks: 1, serverRev: 4 }]);
  });
});
