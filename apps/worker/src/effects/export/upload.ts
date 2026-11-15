import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { PutOptions, Storage } from '@form/ports';
import type { ByteSink } from './table.ts';

/*
 * The upload of an export file (WP-1.17): the bytes a writer produces batch by batch go straight into one `Storage.put`
 * call, through a pipe with back-pressure, so a 100k-row file is never held in memory and the object store receives it
 * while the next batch is still being read. The object appears when `put` returns (the stores write to a temporary object
 * first), so a failed export leaves no half file under its key.
 */

export interface ObjectUpload extends ByteSink {
  /** The pipe a writer that wants a Node stream (exceljs) writes to. */
  readonly stream: PassThrough;
  /** Ends the pipe, waits for the store to finish, and says how many bytes it took. */
  finish(): Promise<{ bytes: number }>;
  /** Gives up: the store's call is failed, and the object is deleted if one was written (best effort). */
  abort(reason: unknown): Promise<void>;
}

export function startUpload(storage: Storage, bucket: 'exports', key: string, options: PutOptions): ObjectUpload {
  const stream = new PassThrough({ highWaterMark: 1024 * 1024 });
  let bytes = 0;
  let failure: unknown;

  async function* counted(): AsyncGenerator<Uint8Array> {
    for await (const chunk of stream) {
      const part = chunk as Uint8Array;
      bytes += part.byteLength;
      yield part;
    }
  }

  // Errors reach the writer through `done` and `write`; this keeps a destroyed pipe from throwing as an unhandled 'error' event.
  stream.on('error', () => undefined);

  const done = storage.put(bucket, key, counted(), options);
  // A store that fails must fail the writer too, or it would wait for a drain that never comes.
  done.catch((err: unknown) => {
    failure = err;
    stream.destroy(err instanceof Error ? err : new Error('upload failed'));
  });

  return {
    stream,
    async write(chunk) {
      if (stream.destroyed) throw failure ?? new Error('the upload is closed');
      if (!stream.write(chunk)) await once(stream, 'drain');
    },
    async finish() {
      stream.end();
      await done;
      return { bytes };
    },
    async abort(reason) {
      failure ??= reason;
      stream.destroy(reason instanceof Error ? reason : new Error('upload aborted'));
      await done.catch(() => undefined);
      await storage.delete(bucket, [key]).catch(() => undefined);
    },
  };
}
