import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_DB_NAME, clearLegacyBuilderDb } from '@/persistence/legacyBuilderDb';
import { cacheDbName } from '@/persistence/repository';

/*
 * BL-273: the signed-out builder's `fORM-builder` database may hold form passwords in plain text from builds before
 * WP-1.06, and nothing read or cleared it after the sign-in gate. It is deleted once, after sign-in.
 */

const names = async () => (await indexedDB.databases()).map((db) => db.name);

const settled = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * Writes `value` under `key` in database `name`, as idb-keyval does (one object store), and lets go of the connection:
 * an open connection would hold a delete back, as it does in a browser.
 */
async function put(name: string, store: string, key: string, value: unknown) {
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore(store);
  const db = await settled(opening);
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** What `key` holds in database `name`, with the connection let go again. */
async function read(name: string, store: string, key: string): Promise<unknown> {
  const db = await settled(indexedDB.open(name));
  const value = await settled(db.transaction(store).objectStore(store).get(key));
  db.close();
  return value;
}

/** The database as the signed-out builder left it: a form whose FormOps hold a plaintext password. */
async function leaveOldDatabase() {
  await put(LEGACY_DB_NAME, 'forms', 'f1', { id: 'f1', format: 'v2', rev: 1, savedAt: '2026-10-01T00:00:00.000Z', doc: { title: 'Old form' }, ops: { open: true, password: 'hunter2' } });
  expect(await read(LEGACY_DB_NAME, 'forms', 'f1')).toMatchObject({ ops: { password: 'hunter2' } });
}

beforeEach(async () => {
  for (const name of await names()) if (name) indexedDB.deleteDatabase(name);
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('clearLegacyBuilderDb', () => {
  it('deletes the old signed-out database, and the plaintext password in it goes with it', async () => {
    await leaveOldDatabase();
    expect(await names()).toContain(LEGACY_DB_NAME);

    await expect(clearLegacyBuilderDb()).resolves.toBe('deleted');

    expect(await names()).not.toContain(LEGACY_DB_NAME);
  });

  it('leaves the per-org caches and the other databases of the builder alone', async () => {
    await leaveOldDatabase();
    await put(cacheDbName('org-1'), 'forms', 'f2', { id: 'f2' });
    await put('fORM-submissions', 'submissions', 's1', { id: 's1' });

    await clearLegacyBuilderDb();

    const left = await names();
    expect(left).toContain('fORM-builder:org-1');
    expect(left).toContain('fORM-submissions');
    expect(left).not.toContain(LEGACY_DB_NAME);
    expect(await read(cacheDbName('org-1'), 'forms', 'f2')).toEqual({ id: 'f2' });
  });

  it('does it once: a later sign-in in this browser does not ask again', async () => {
    await leaveOldDatabase();
    await clearLegacyBuilderDb();
    const spy = vi.spyOn(indexedDB, 'deleteDatabase');

    await expect(clearLegacyBuilderDb()).resolves.toBe('already_done');

    expect(spy).not.toHaveBeenCalled();
  });

  it('a browser that never had the database is done too, without creating it', async () => {
    await expect(clearLegacyBuilderDb()).resolves.toBe('deleted');
    expect(await names()).not.toContain(LEGACY_DB_NAME);
    expect(localStorage.getItem('fr.legacyBuilderDbDeleted')).toBe('1');
  });

  it('with storage blocked it still deletes, and asks again next time (which costs nothing)', async () => {
    await leaveOldDatabase();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    await expect(clearLegacyBuilderDb()).resolves.toBe('deleted');
    expect(await names()).not.toContain(LEGACY_DB_NAME);
  });

  it('does not mark itself done when the delete fails or is blocked, so the next sign-in tries again', async () => {
    vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent));
      return request;
    });
    await expect(clearLegacyBuilderDb()).resolves.toBe('blocked');
    expect(localStorage.getItem('fr.legacyBuilderDbDeleted')).toBeNull();

    vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => request.onerror?.(new Event('error')));
      return request;
    });
    await expect(clearLegacyBuilderDb()).resolves.toBe('failed');
    expect(localStorage.getItem('fr.legacyBuilderDbDeleted')).toBeNull();
  });

  it('never throws: a browser that refuses to delete answers failed', async () => {
    vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      throw new DOMException('no', 'SecurityError');
    });
    await expect(clearLegacyBuilderDb()).resolves.toBe('failed');
  });

  it('a browser without IndexedDB has nothing to delete', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(clearLegacyBuilderDb()).resolves.toBe('unavailable');
    vi.unstubAllGlobals();
  });
});
