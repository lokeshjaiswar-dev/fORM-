/*
 * The signed-out builder kept its forms in one IndexedDB database named `fORM-builder`, before the sign-in gate (BL-206,
 * WP-1.06). Builds before WP-1.06 kept a form's password in plain text in those records, and the builder has read only
 * the per-org caches `fORM-builder:<orgId>` ever since, so nothing reads that database, nothing clears it, and the
 * passwords sit at rest in the browser for good. BL-273: it is deleted once, after sign-in. The signed-out builder is
 * gone (a product-owner decision of WP-1.06), so forms only that database held are not copied into an org.
 */

/** The name of the old signed-out builder's database. The per-org caches add `:<orgId>` and are not touched. */
export const LEGACY_DB_NAME = 'fORM-builder';

/** Set once the database is gone, so later sign-ins in this browser do not ask again. */
const DONE_KEY = 'fr.legacyBuilderDbDeleted';

export type LegacyDbResult = 'deleted' | 'already_done' | 'unavailable' | 'blocked' | 'failed';

function wasDone(): boolean {
  try {
    return globalThis.localStorage?.getItem(DONE_KEY) === '1';
  } catch {
    return false;
  }
}

function markDone(): void {
  try {
    globalThis.localStorage?.setItem(DONE_KEY, '1');
  } catch {
    /* Private browsing or blocked storage: the next sign-in asks again, which costs nothing when the database is gone. */
  }
}

/**
 * Deletes the old signed-out builder's database, unless an earlier call already did. Deleting a database that does not
 * exist succeeds, so a browser that never had one is marked done too. A tab of an older build that still holds the
 * database open `blocked` the delete: it goes through when that tab lets go (the request is left pending, and marks the
 * browser done then), and otherwise the next sign-in tries again. Never throws.
 */
export function clearLegacyBuilderDb(): Promise<LegacyDbResult> {
  if (wasDone()) return Promise.resolve('already_done');
  const factory = globalThis.indexedDB;
  if (!factory) return Promise.resolve('unavailable');
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.deleteDatabase(LEGACY_DB_NAME);
    } catch {
      resolve('failed');
      return;
    }
    request.onsuccess = () => {
      markDone();
      resolve('deleted');
    };
    request.onerror = () => resolve('failed');
    request.onblocked = () => resolve('blocked');
  });
}

let started: Promise<LegacyDbResult> | null = null;

/** `clearLegacyBuilderDb` at most once per page load, however many components ask (React runs effects twice in development). */
export function clearLegacyBuilderDbOnce(): Promise<LegacyDbResult> {
  started ??= clearLegacyBuilderDb();
  return started;
}
