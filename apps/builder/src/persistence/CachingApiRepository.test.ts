import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { CachingApiRepository } from '@/persistence/CachingApiRepository';
import { newStoredForm } from '@/persistence/openForm';
import { MemoryRepository, formWith } from '@/test/fixtures';

const listRemoteForms = vi.fn();
const getRemoteDraft = vi.fn();
const putRemoteDraft = vi.fn();
const deleteRemoteForm = vi.fn();

vi.mock('@/persistence/draftsApi', () => ({
  listRemoteForms: (...args: unknown[]) => listRemoteForms(...args),
  getRemoteDraft: (...args: unknown[]) => getRemoteDraft(...args),
  putRemoteDraft: (...args: unknown[]) => putRemoteDraft(...args),
  deleteRemoteForm: (...args: unknown[]) => deleteRemoteForm(...args),
}));

const NOW = '2026-10-19T04:30:00.000Z';
const LATER = '2026-10-19T05:00:00.000Z';

describe('CachingApiRepository', () => {
  beforeEach(() => {
    listRemoteForms.mockReset().mockResolvedValue(null);
    getRemoteDraft.mockReset().mockResolvedValue(null);
    putRemoteDraft.mockReset().mockResolvedValue(undefined);
    deleteRemoteForm.mockReset().mockResolvedValue(undefined);
  });

  it('keeps the form in this browser when the API cannot be reached', async () => {
    listRemoteForms.mockRejectedValue(new ApiUnreachable());
    putRemoteDraft.mockRejectedValue(new ApiUnreachable());
    const cache = new MemoryRepository();
    const form = newStoredForm('f1', NOW, { ...formWith([]), title: 'Hello' });
    const repo = new CachingApiRepository(cache);
    await repo.save(form);
    expect(await cache.load('f1')).toEqual(form);
    expect(await repo.list()).toEqual([{ id: 'f1', title: 'Hello', savedAt: NOW, blocks: 0 }]);
  });

  it('does not keep a local copy when the API refuses the draft', async () => {
    listRemoteForms.mockResolvedValue([]);
    putRemoteDraft.mockRejectedValue(new ApiProblem(403, 'FORBIDDEN', 'no'));
    const cache = new MemoryRepository();
    const form = newStoredForm('f1', NOW, { ...formWith([]), title: 'Hello' });
    await expect(new CachingApiRepository(cache).save(form)).rejects.toBeInstanceOf(ApiProblem);
    expect(await cache.load('f1')).toBeNull();
  });

  it('saves the definition through the API and keeps ops only in the local cache', async () => {
    listRemoteForms.mockResolvedValue([]);
    const cache = new MemoryRepository();
    const repo = new CachingApiRepository(cache);
    const form = newStoredForm('f1', NOW, { ...formWith([]), title: 'Hello' });
    await repo.save(form);
    expect(await cache.load('f1')).toEqual(form);
    expect(putRemoteDraft).toHaveBeenCalledWith('f1', form.doc, 'Hello');
  });

  it('lists only the forms the API returned', async () => {
    const cache = new MemoryRepository();
    await cache.save(newStoredForm('local-only', NOW, { ...formWith([]), title: 'Browser' }));
    listRemoteForms.mockResolvedValue([{ id: 'remote', title: 'From API', updatedAt: LATER }]);
    const repo = new CachingApiRepository(cache);
    expect(await repo.list()).toEqual([{ id: 'remote', title: 'From API', savedAt: LATER, blocks: 0 }]);
  });

  it('loads a remote draft and keeps local ops', async () => {
    listRemoteForms.mockResolvedValue([]);
    const cache = new MemoryRepository();
    const local = newStoredForm('f1', LATER);
    local.ops = { open: false, closedMessage: { type: 'doc', content: [] }, password: 'secret' };
    await cache.save(local);
    getRemoteDraft.mockResolvedValue({
      draftRev: 4,
      schemaVersion: 2,
      draft: { schemaVersion: 2, title: 'Server' },
      updatedAt: NOW,
    });
    const loaded = await new CachingApiRepository(cache).load('f1');
    expect(loaded).toMatchObject({ rev: 4, doc: { title: 'Server' }, ops: local.ops });
  });

  it('trashes the form on the API, then drops the browser copy', async () => {
    listRemoteForms.mockResolvedValue([]);
    const cache = new MemoryRepository();
    await cache.save(newStoredForm('f1', NOW));
    const repo = new CachingApiRepository(cache);
    await repo.remove('f1');
    expect(deleteRemoteForm).toHaveBeenCalledWith('f1');
    expect(await cache.load('f1')).toBeNull();
  });

  it('deletes only the browser copy when the API is down', async () => {
    listRemoteForms.mockResolvedValue(null);
    const cache = new MemoryRepository();
    await cache.save(newStoredForm('f1', NOW));
    const repo = new CachingApiRepository(cache);
    await repo.remove('f1');
    expect(deleteRemoteForm).not.toHaveBeenCalled();
    expect(await cache.load('f1')).toBeNull();
  });
});
