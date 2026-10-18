import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BUCKET_NAMES,
  MAX_PRESIGN_EXPIRES_SEC,
  PortError,
  isValidObjectKey,
  isValidObjectTags,
  type BucketName,
  type ByteRange,
  type ByteStream,
  type ObjRef,
  type ObjectHead,
  type PresignGetInput,
  type PresignPostInput,
  type PresignedPost,
  type PutOptions,
  type Storage,
  type StorageCapabilities,
} from '@form/ports';
import { hasControlChars } from '../text.ts';

export interface FilesystemStorageOptions {
  /** Directory that holds every bucket; created on demand. */
  root: string;
  /** Absolute base URL of the dev endpoint that serves this store, e.g. `http://localhost:8080/_dev/storage`. */
  publicUrl: string;
  /** HMAC key for presigned URLs, at least 32 bytes. */
  signingKey: Uint8Array;
  /** Milliseconds since the epoch; injectable for expiry tests. */
  now?: () => number;
}

export interface UploadedFile {
  body: Uint8Array;
  contentType: string;
}

/**
 * Dev and test object store on the local disk (never for production: no SSE, versioning or Object Lock).
 * Objects are stored under the SHA-256 of their key, so keys never become paths. The dev HTTP endpoint
 * that serves `publicUrl` calls `acceptPresignedPost` and `resolvePresignedGet`, which enforce what S3
 * would: signature, expiry, key, content type and size range.
 *
 * Each file is replaced atomically, but an object is two files (bytes, then metadata), so a read racing
 * an overwrite can briefly pair new bytes with old metadata. On Windows, overwriting or deleting an
 * object while a read stream is open fails with EPERM. Both are acceptable for a single-developer store.
 */
export interface FilesystemStorage extends Storage {
  acceptPresignedPost(bucket: string, fields: Record<string, string>, file: UploadedFile): Promise<{ key: string }>;
  resolvePresignedGet(url: string): Promise<{ bucket: BucketName; key: string; downloadName?: string }>;
  /** The tags a presigned upload applied (copies keep them, `put` clears them, as on S3); null when there is no object. */
  objectTags(bucket: BucketName, key: string): Promise<Record<string, string> | null>;
}

interface Meta {
  key: string;
  bytes: number;
  contentType: string;
  etag: string;
  tags?: Record<string, string>;
}

interface PostPolicy {
  b: BucketName;
  k: string;
  ct: string;
  min: number;
  max: number;
  exp: number;
  tags?: Record<string, string>;
}

const CONTENT_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"\\\r\n]*"))*$/;
const CAPABILITIES: StorageCapabilities = { objectLock: false, versioning: false, sse: false };

const invalid = (message: string) => new PortError('invalid_argument', message);

function checkBucket(bucket: string): BucketName {
  if (!(BUCKET_NAMES as readonly string[]).includes(bucket)) throw invalid(`unknown bucket: ${bucket}`);
  return bucket as BucketName;
}

function checkKey(key: string): string {
  if (!isValidObjectKey(key)) throw invalid(`invalid object key: ${JSON.stringify(key)}`);
  return key;
}

function checkContentType(contentType: string): string {
  if (!CONTENT_TYPE.test(contentType)) throw invalid(`invalid content type: ${JSON.stringify(contentType)}`);
  return contentType;
}

function checkExpires(expiresSec: number): number {
  if (!Number.isInteger(expiresSec) || expiresSec < 1 || expiresSec > MAX_PRESIGN_EXPIRES_SEC) {
    throw invalid(`expiresSec must be an integer in 1..${MAX_PRESIGN_EXPIRES_SEC}`);
  }
  return expiresSec;
}

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');

/** `+name` or `-`, so an appended empty `dl=` does not verify against a URL signed without one. */
const getPayload = (bucket: string, key: string, exp: number, dl: string | undefined) =>
  `get\n${bucket}\n${key}\n${exp}\n${dl === undefined ? '-' : `+${dl}`}`;

function sameSignature(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createFilesystemStorage(o: FilesystemStorageOptions): FilesystemStorage {
  if (o.signingKey.byteLength < 32) throw invalid('signingKey must be at least 32 bytes');
  const base = new URL(o.publicUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw invalid('publicUrl must be http(s)');
  const publicUrl = base.href.replace(/\/$/, '');
  const root = path.resolve(o.root);
  const tmpDir = path.join(root, '.tmp');
  const now = o.now ?? Date.now;
  const sign = (payload: string) => createHmac('sha256', o.signingKey).update(payload).digest('base64url');

  const objectPath = (bucket: BucketName, key: string) => path.join(root, bucket, createHash('sha256').update(key).digest('hex'));
  const metaPath = (bucket: BucketName, key: string) => `${objectPath(bucket, key)}.json`;

  async function readMeta(bucket: BucketName, key: string): Promise<Meta | null> {
    try {
      return JSON.parse(await readFile(metaPath(bucket, key), 'utf8')) as Meta;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async function commit(bucket: BucketName, key: string, tmpObject: string, meta: Meta): Promise<void> {
    const tmpMeta = path.join(tmpDir, `${randomUUID()}.json`);
    try {
      await mkdir(path.join(root, bucket), { recursive: true });
      await writeFile(tmpMeta, JSON.stringify(meta));
      await rename(tmpObject, objectPath(bucket, key));
      await rename(tmpMeta, metaPath(bucket, key));
    } catch (e) {
      await rm(tmpObject, { force: true });
      await rm(tmpMeta, { force: true });
      throw e;
    }
  }

  async function write(bucket: BucketName, key: string, body: ByteStream | Uint8Array, contentType: string, tags?: Record<string, string>): Promise<void> {
    await mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, randomUUID());
    const hash = createHash('sha256');
    let bytes = 0;
    const fh = await open(tmp, 'w');
    try {
      const chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array> = body instanceof Uint8Array ? [body] : body;
      for await (const chunk of chunks) {
        hash.update(chunk);
        bytes += chunk.byteLength;
        await fh.write(chunk);
      }
    } catch (e) {
      await fh.close();
      await rm(tmp, { force: true });
      throw e;
    }
    await fh.close();
    await commit(bucket, key, tmp, { key, bytes, contentType, etag: hash.digest('hex').slice(0, 32), ...(tags ? { tags } : {}) });
  }

  const storage: FilesystemStorage = {
    async presignPost(i: PresignPostInput): Promise<PresignedPost> {
      const bucket = checkBucket(i.bucket);
      const key = checkKey(i.key);
      const contentType = checkContentType(i.contentType);
      const expiresSec = checkExpires(i.expiresSec);
      if (!Number.isInteger(i.minBytes) || !Number.isInteger(i.maxBytes) || i.minBytes < 0 || i.minBytes > i.maxBytes) {
        throw invalid('need integers 0 <= minBytes <= maxBytes');
      }
      if (i.tags && !isValidObjectTags(i.tags)) throw invalid('invalid object tags');
      const policy: PostPolicy = {
        b: bucket,
        k: key,
        ct: contentType,
        min: i.minBytes,
        max: i.maxBytes,
        exp: Math.floor(now() / 1000) + expiresSec,
        ...(i.tags ? { tags: i.tags } : {}),
      };
      const encoded = b64url(JSON.stringify(policy));
      return {
        url: `${publicUrl}/${bucket}`,
        fields: { key, 'Content-Type': contentType, policy: encoded, 'x-fr-signature': sign(`post\n${encoded}`) },
      };
    },

    async presignGet(i: PresignGetInput): Promise<string> {
      const bucket = checkBucket(i.bucket);
      const key = checkKey(i.key);
      const exp = Math.floor(now() / 1000) + checkExpires(i.expiresSec);
      const dl = i.downloadName;
      if (dl !== undefined && (dl.length === 0 || dl.length > 255 || hasControlChars(dl) || /["\\/]/.test(dl))) throw invalid('invalid downloadName');
      const q = new URLSearchParams({ exp: String(exp) });
      if (i.downloadName !== undefined) q.set('dl', i.downloadName);
      q.set('sig', sign(getPayload(bucket, key, exp, dl)));
      return `${publicUrl}/${bucket}/${encodeURIComponent(key)}?${q.toString()}`;
    },

    async head(bucket, key): Promise<ObjectHead | null> {
      const meta = await readMeta(checkBucket(bucket), checkKey(key));
      return meta && { bytes: meta.bytes, contentType: meta.contentType, etag: meta.etag };
    },

    async get(bucket, key, range?: ByteRange): Promise<ByteStream> {
      const b = checkBucket(bucket);
      const meta = await readMeta(b, checkKey(key));
      if (!meta) throw new PortError('not_found', `no object ${bucket}/${key}`);
      if (!range) return createReadStream(objectPath(b, key));
      const { start, end } = range;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= meta.bytes) {
        throw invalid(`unsatisfiable range ${start}-${end} for ${meta.bytes} bytes`);
      }
      return createReadStream(objectPath(b, key), { start, end: Math.min(end, meta.bytes - 1) });
    },

    async put(bucket, key, body, opts: PutOptions): Promise<void> {
      const b = checkBucket(bucket);
      checkKey(key);
      checkContentType(opts.contentType);
      if (opts.objectLock) throw new PortError('unsupported', 'the filesystem store has no Object Lock');
      if (opts.sse) throw new PortError('unsupported', 'the filesystem store has no server-side encryption');
      await write(b, key, body, opts.contentType);
    },

    async copy(src: ObjRef, dst: ObjRef): Promise<void> {
      const sb = checkBucket(src.bucket);
      const db = checkBucket(dst.bucket);
      checkKey(src.key);
      checkKey(dst.key);
      if (src.versionId !== undefined || dst.versionId !== undefined) throw new PortError('unsupported', 'the filesystem store has no versioning');
      const meta = await readMeta(sb, src.key);
      if (!meta) throw new PortError('not_found', `no object ${src.bucket}/${src.key}`);
      await mkdir(tmpDir, { recursive: true });
      const tmp = path.join(tmpDir, randomUUID());
      try {
        await copyFile(objectPath(sb, src.key), tmp);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
      await commit(db, dst.key, tmp, { ...meta, key: dst.key });
    },

    async delete(bucket, keys): Promise<void> {
      const b = checkBucket(bucket);
      const plain = keys.map((k) => {
        if (typeof k !== 'string') throw new PortError('unsupported', 'the filesystem store has no versioning');
        return checkKey(k);
      });
      for (const key of plain) {
        await rm(metaPath(b, key), { force: true });
        await rm(objectPath(b, key), { force: true });
      }
    },

    async objectTags(bucket, key) {
      const meta = await readMeta(checkBucket(bucket), checkKey(key));
      return meta && { ...meta.tags };
    },

    async capabilities() {
      return { ...CAPABILITIES };
    },

    async acceptPresignedPost(bucket, fields, file) {
      const b = checkBucket(bucket);
      const encoded = fields.policy ?? '';
      if (!sameSignature(fields['x-fr-signature'] ?? '', sign(`post\n${encoded}`))) {
        throw new PortError('integrity', 'presigned POST signature mismatch');
      }
      const policy = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as PostPolicy;
      if (Math.floor(now() / 1000) > policy.exp) throw new PortError('expired', 'presigned POST has expired');
      if (policy.b !== b || fields.key !== policy.k) throw invalid('upload does not match the presigned bucket and key');
      if (fields['Content-Type'] !== policy.ct || file.contentType !== policy.ct) throw invalid('upload content type does not match the policy');
      if (file.body.byteLength < policy.min || file.body.byteLength > policy.max) {
        throw invalid(`upload size ${file.body.byteLength} outside ${policy.min}..${policy.max}`);
      }
      await write(b, policy.k, file.body, policy.ct, policy.tags);
      return { key: policy.k };
    },

    async resolvePresignedGet(url) {
      const u = URL.parse(url);
      if (!u) throw invalid('malformed presigned URL');
      const prefix = `${publicUrl}/`;
      const target = `${u.origin}${u.pathname}`;
      if (!target.startsWith(prefix)) throw invalid('URL is not served by this store');
      const rest = target.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) throw invalid('URL names no object');
      const bucket = checkBucket(rest.slice(0, slash));
      let key: string;
      try {
        key = decodeURIComponent(rest.slice(slash + 1));
      } catch {
        throw invalid('malformed presigned URL');
      }
      checkKey(key);
      const exp = Number(u.searchParams.get('exp'));
      const dl = u.searchParams.get('dl') ?? undefined;
      if (!sameSignature(u.searchParams.get('sig') ?? '', sign(getPayload(bucket, key, exp, dl)))) {
        throw new PortError('integrity', 'presigned GET signature mismatch');
      }
      if (Math.floor(now() / 1000) > exp) throw new PortError('expired', 'presigned GET has expired');
      return dl === undefined ? { bucket, key } : { bucket, key, downloadName: dl };
    },
  };
  return storage;
}
