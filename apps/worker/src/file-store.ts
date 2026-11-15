import { unlink } from 'node:fs/promises';
import path from 'node:path';

/*
 * The part of the respondent file store the worker uses: removing bytes. The API writes them as `<dir>/<uuid>.bin`
 * (`apps/api/src/files.ts`, `FILE_STORE_DIR`); the worker must be given the same directory. The local filesystem is
 * temporary: the StoragePort / S3 adapter with lifecycle rules replaces both sides in WP-1.14.
 */
export interface UploadStore {
  /** Removes the bytes of a file; a file that is not there is already removed. Any other failure is thrown. */
  remove(id: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `<dir>/<uuid>.bin`. The id must be a uuid, so no id can name a path outside `dir`. */
export function createUploadStore(dir: string): UploadStore {
  const root = path.resolve(dir);
  return {
    async remove(id) {
      if (!UUID.test(id)) throw new TypeError('file id must be a uuid');
      try {
        await unlink(path.join(root, `${id}.bin`));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },
  };
}
