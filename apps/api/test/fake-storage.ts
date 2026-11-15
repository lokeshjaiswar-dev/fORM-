import { createHash } from 'node:crypto';
import { PortError, type BucketName, type ByteStream, type Storage } from '@form/ports';

/**
 * An object store in memory, for tests of the routes that stream a file from it (the export download). It keeps what the
 * port promises: a missing object is `head` → null and `get` → `PortError('not_found')`, and a key is checked the way every
 * real store does. `reads` counts the `get` calls, so a test can prove a refused download never touched the store.
 */
export interface FakeStorage extends Storage {
  /** Puts an object the way the export worker does. */
  seed(bucket: BucketName, key: string, bytes: Uint8Array | string): void;
  /** Removes an object (the sweep that expires exports). */
  remove(bucket: BucketName, key: string): void;
  readonly reads: string[];
}

export function createFakeStorage(): FakeStorage {
  const objects = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const at = (bucket: BucketName, key: string) => `${bucket}/${key}`;
  const unsupported = (what: string) => async (): Promise<never> => {
    throw new PortError('unsupported', `the fake object store has no ${what}`);
  };
  async function* chunks(bytes: Uint8Array): ByteStream {
    // Two chunks, so a streamed answer is proven to be reassembled and not just one buffer passed through.
    const half = Math.ceil(bytes.length / 2);
    yield bytes.slice(0, half);
    if (half < bytes.length) yield bytes.slice(half);
  }
  return {
    reads,
    seed: (bucket, key, bytes) => void objects.set(at(bucket, key), typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes),
    remove: (bucket, key) => void objects.delete(at(bucket, key)),
    presignPost: unsupported('presigned posts'),
    presignGet: unsupported('presigned urls'),
    async head(bucket, key) {
      const found = objects.get(at(bucket, key));
      return found ? { bytes: found.length, etag: createHash('sha256').update(found).digest('hex') } : null;
    },
    async get(bucket, key) {
      reads.push(at(bucket, key));
      const found = objects.get(at(bucket, key));
      if (!found) throw new PortError('not_found', `no object ${at(bucket, key)}`);
      return chunks(found);
    },
    async put(bucket, key, body) {
      if (body instanceof Uint8Array) {
        objects.set(at(bucket, key), body);
        return;
      }
      const parts: Uint8Array[] = [];
      for await (const part of body) parts.push(part);
      objects.set(at(bucket, key), Buffer.concat(parts));
    },
    copy: unsupported('copy'),
    async delete(bucket, keys) {
      for (const k of keys) objects.delete(at(bucket, typeof k === 'string' ? k : k.key));
    },
    async capabilities() {
      return { objectLock: false, versioning: false, sse: false };
    },
  };
}
