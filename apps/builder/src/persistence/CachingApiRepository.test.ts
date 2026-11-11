import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CachingApiRepository } from '@/persistence/CachingApiRepository';
import { newStoredForm } from '@/persistence/openForm';
import { MemoryRepository, formWith } from '@/test/fixtures';

const listRemoteForms = vi.fn();
const getRemoteDraft = vi.fn();
const putRemoteDraft = vi.fn();

vi.mock('@/persistence/draftsApi', () => ({
  listRemoteForms: (...args: unknown[]) => listRemoteForms(...args),
  getRemoteDraft: (...args: unknown[]) => getRemoteDraft(...args),
  putRemoteDraft: (...args: unknown[]) => putRemoteDraft(...args),
}));

const NOW = '2026-10-19T04:30:00.000Z';
const LATER = '2026-10-19T05:00:00.000Z';

describe('CachingApiRepository', () => {
  beforeEach(() => {
    listRemoteForms.mockReset().mockResolvedValue(null);
    getRemoteDraft.mockReset().mockResolvedValue(null);
    putRemoteDraft.mockReset().mockResolvedValue(undefined);
  });

  it('still saves locally when the API refuses the draft', async () => {
    putRemoteDraft.mockRejectedValue(new Error('no org'));
    const cache = new MemoryRepository();
    const form = newStoredForm('f1', NOW, { ...formWith([]), title: 'Hello' });
    await new CachingApiRepository(cache).save(form);
    expect(await cache.load('f1')).toEqual(form);
  });

  it('saves the definition through the API and keeps ops only in the local cache', async () => {
    const cache = new MemoryRepository();
    const repo = new CachingApiRepository(cache);
    const form = newStoredForm('f1', NOW, { ...formWith([]), title: 'Hello' });
    await repo.save(form);
    expect(await cache.load('f1')).toEqual(form);
    expect(putRemoteDraft).toHaveBeenCalledWith('f1', form.doc, 'Hello');
  });

  it('lists remote forms that are not in this browser yet', async () => {
    listRemoteForms.mockResolvedValue([{ id: 'remote', title: 'From API', updatedAt: LATER }]);
    const repo = new CachingApiRepository(new MemoryRepository());
    expect(await repo.list()).toEqual([{ id: 'remote', title: 'From API', savedAt: LATER, blocks: 0 }]);
  });

  it('loads a remote draft and keeps local ops', async () => {
    const cache = new MemoryRepository();
    const local = newStoredForm('f1', NOW);
    local.ops = { open: false, closedMessage: { type: 'doc', content: [] }, password: 'secret' };
    await cache.save(local);
    getRemoteDraft.mockResolvedValue({
      draftRev: 4,
      schemaVersion: 2,
      draft: { schemaVersion: 2, title: 'Server' },
      updatedAt: LATER,
    });
    const loaded = await new CachingApiRepository(cache).load('f1');
    expect(loaded).toMatchObject({ rev: 4, doc: { title: 'Server' }, ops: local.ops });
  });
});
