import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BUCKET_NAMES, PortError, type BucketName, type ByteStream, type EgressGuard, type Storage, type StorageCapabilities } from '@form/ports';
import { assertEndpoint, egressLookup } from '../egress/http.ts';
import { checkBucket, checkContentType, checkDownloadName, checkExpires, checkKey, checkPostInput, checkRange } from './checks.ts';

export interface S3StorageOptions {
  region: string;
  /** Unset: AWS S3. Set: a bring-your-own S3-compatible store (ADR-0018). */
  endpoint?: string | undefined;
  /** Path-style addressing; S3-compatible stores usually need it. */
  forcePathStyle?: boolean;
  /** Where browsers reach the store when it differs from `endpoint`; presigned URLs are signed for this host. */
  publicEndpoint?: string | undefined;
  /**
   * Default: the SDK chain (IRSA, instance profile, environment). Its STS and metadata requests do not pass the
   * egress guard (architecture §6, BL-255), so `allowlist` and `none` installs set static keys.
   */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined;
  /** The real bucket behind each port bucket. */
  buckets: Readonly<Record<BucketName, string>>;
  /** Server-side encryption applied to every write; without it, asking for SSE is PortError('unsupported'). */
  sse?: { mode: 'aws:kms'; kmsKeyId?: string | undefined } | { mode: 'AES256' } | undefined;
  /** Every connection to the store passes the guard (on-prem: the store must be in EGRESS_ALLOWLIST). */
  egress: EgressGuard;
  timeoutMs?: number;
  /** Streams larger than this go up as multipart uploads in parts of this size. Default 8 MiB. */
  partBytes?: number;
}

export interface S3Storage extends Storage {
  /** Creates missing buckets: `audit` with Object Lock when `objectLockAudit`, `uploads` and `assets` versioned (dev setup and tests). */
  ensureBuckets(o?: { objectLockAudit?: boolean; versioned?: readonly BucketName[] }): Promise<void>;
}

const MISSING = new Set(['NoSuchKey', 'NotFound', 'NoSuchVersion']);
const NO_LOCK = new Set(['ObjectLockConfigurationNotFoundError', 'NotImplemented', 'InvalidRequest', 'NoSuchObjectLockConfiguration']);

function s3Error(e: unknown, what: string): PortError {
  if (e instanceof PortError) return e;
  if (e instanceof S3ServiceException) {
    if (MISSING.has(e.name) || e.$metadata.httpStatusCode === 404) return new PortError('not_found', `${what}: ${e.name}`, { cause: e });
    if (e.name === 'InvalidRange' || e.$metadata.httpStatusCode === 416) return new PortError('invalid_argument', `${what}: the range is not satisfiable`, { cause: e });
  }
  return new PortError('unavailable', `${what} failed: ${(e as Error).name}: ${(e as Error).message}`, { cause: e });
}

const unquote = (etag: string | undefined) => (etag ?? '').replace(/^W\//, '').replace(/^"|"$/g, '');
const copySource = (bucket: string, key: string, versionId?: string) =>
  `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''}`;

function tagging(tags: Record<string, string>): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<Tagging><TagSet>${Object.entries(tags)
    .map(([k, v]) => `<Tag><Key>${esc(k)}</Key><Value>${esc(v)}</Value></Tag>`)
    .join('')}</TagSet></Tagging>`;
}

function client(o: S3StorageOptions, endpoint: string | undefined): { s3: S3Client; ready: () => Promise<void> } {
  const url = new URL(endpoint ?? `https://s3.${o.region}.amazonaws.com`);
  const protocol = url.protocol === 'http:' ? 'http:' : 'https:';
  const lookup = egressLookup(o.egress, protocol, url.port);
  const s3 = new S3Client({
    region: o.region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: o.forcePathStyle ?? endpoint !== undefined,
    ...(o.credentials ? { credentials: o.credentials } : {}),
    maxAttempts: 3,
    requestHandler: {
      requestTimeout: o.timeoutMs ?? 30_000,
      httpAgent: new HttpAgent({ keepAlive: true, lookup }),
      httpsAgent: new HttpsAgent({ keepAlive: true, lookup }),
    },
  });
  return { s3, ready: assertEndpoint(o.egress, url) };
}

/**
 * Object storage over the S3 API (architecture §6, ADR-0018): AWS S3 on SaaS, any S3-compatible store on-prem, and
 * SeaweedFS in development and CI. `capabilities()` reports what the buckets actually have (Object Lock on `audit`,
 * versioning on `uploads`), so a store without Object Lock sends checkpoints to the SIEM instead (§2.7).
 */
export function createS3Storage(o: S3StorageOptions): S3Storage {
  for (const b of BUCKET_NAMES) if (!o.buckets[b]) throw new PortError('invalid_argument', `no bucket configured for ${b}`);
  const { s3, ready } = client(o, o.endpoint);
  const signer = o.publicEndpoint ? client(o, o.publicEndpoint).s3 : s3;
  const name = (b: BucketName) => o.buckets[checkBucket(b)];
  const sseParams = (): Pick<PutObjectCommandInput, 'ServerSideEncryption' | 'SSEKMSKeyId'> =>
    !o.sse ? {} : o.sse.mode === 'AES256' ? { ServerSideEncryption: 'AES256' } : { ServerSideEncryption: 'aws:kms', ...(o.sse.kmsKeyId ? { SSEKMSKeyId: o.sse.kmsKeyId } : {}) };

  const probes = new Map<string, Promise<boolean>>();
  const probe = (key: string, run: () => Promise<boolean>): Promise<boolean> => {
    let p = probes.get(key);
    if (!p) {
      p = run();
      probes.set(key, p);
      p.catch(() => probes.delete(key));
    }
    return p;
  };
  const locked = (b: BucketName) =>
    probe(`lock:${b}`, async () => {
      await ready();
      try {
        const r = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: name(b) }));
        return r.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled';
      } catch (e) {
        if (e instanceof S3ServiceException && (NO_LOCK.has(e.name) || e.$metadata.httpStatusCode === 404)) return false;
        throw s3Error(e, `object lock of ${b}`);
      }
    });
  const versioned = (b: BucketName) =>
    probe(`versioning:${b}`, async () => {
      await ready();
      try {
        return (await s3.send(new GetBucketVersioningCommand({ Bucket: name(b) }))).Status === 'Enabled';
      } catch (e) {
        throw s3Error(e, `versioning of ${b}`);
      }
    });
  const needVersioning = async (b: BucketName) => {
    if (!(await versioned(b))) throw new PortError('unsupported', `bucket ${b} is not versioned`);
  };

  return {
    async presignPost(i) {
      checkPostInput(i);
      const tags = i.tags && Object.keys(i.tags).length > 0 ? tagging(i.tags) : undefined;
      const sse = sseParams();
      const fields: Record<string, string> = {
        'Content-Type': i.contentType,
        ...(tags ? { tagging: tags } : {}),
        ...(sse.ServerSideEncryption ? { 'x-amz-server-side-encryption': sse.ServerSideEncryption } : {}),
        ...(sse.SSEKMSKeyId ? { 'x-amz-server-side-encryption-aws-kms-key-id': sse.SSEKMSKeyId } : {}),
      };
      try {
        const post = await createPresignedPost(signer, {
          Bucket: name(i.bucket),
          Key: i.key,
          Conditions: [['content-length-range', i.minBytes, i.maxBytes]],
          Fields: fields,
          Expires: i.expiresSec,
        });
        return { url: post.url, fields: post.fields };
      } catch (e) {
        throw s3Error(e, 'presign POST');
      }
    },

    async presignGet(i) {
      const key = checkKey(i.key);
      const expiresIn = checkExpires(i.expiresSec);
      const dl = checkDownloadName(i.downloadName);
      const disposition = dl === undefined ? 'attachment' : `attachment; filename="${dl.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(dl)}`;
      return getSignedUrl(signer, new GetObjectCommand({ Bucket: name(i.bucket), Key: key, ResponseContentDisposition: disposition }), { expiresIn });
    },

    async head(bucket, key) {
      const Bucket = name(bucket);
      checkKey(key);
      await ready();
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { bytes: r.ContentLength ?? 0, ...(r.ContentType ? { contentType: r.ContentType } : {}), etag: unquote(r.ETag) };
      } catch (e) {
        const err = s3Error(e, `head ${bucket}/${key}`);
        if (err.code === 'not_found') return null;
        throw err;
      }
    },

    async get(bucket, key, range) {
      const Bucket = name(bucket);
      checkKey(key);
      if (range) checkRange(range);
      await ready();
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket, Key: key, ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }));
        if (!r.Body) throw new PortError('unavailable', `get ${bucket}/${key}: no body`);
        return r.Body as unknown as ByteStream;
      } catch (e) {
        throw s3Error(e, `get ${bucket}/${key}`);
      }
    },

    async put(bucket, key, body, opts) {
      const Bucket = name(bucket);
      checkKey(key);
      checkContentType(opts.contentType);
      if (opts.sse && !o.sse) throw new PortError('unsupported', 'this store is configured without server-side encryption');
      if (opts.objectLock && !(await locked(bucket))) throw new PortError('unsupported', `bucket ${bucket} has no Object Lock`);
      const params: PutObjectCommandInput = {
        Bucket,
        Key: key,
        ContentType: opts.contentType,
        ...sseParams(),
        ...(opts.objectLock ? { ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: opts.objectLock.retainUntil } : {}),
      };
      await ready();
      try {
        if (body instanceof Uint8Array) {
          await s3.send(new PutObjectCommand({ ...params, Body: body, ContentLength: body.byteLength }));
        } else {
          const Body = Readable.from(body);
          await new Upload({ client: s3, params: { ...params, Body }, partSize: o.partBytes ?? 8 * 1024 * 1024, queueSize: 4 }).done();
        }
      } catch (e) {
        throw s3Error(e, `put ${bucket}/${key}`);
      }
    },

    async copy(src, dst) {
      const from = name(src.bucket);
      const to = name(dst.bucket);
      checkKey(src.key);
      checkKey(dst.key);
      if (dst.versionId !== undefined) throw new PortError('invalid_argument', 'a copy creates the destination version; it cannot name one');
      if (src.versionId !== undefined) await needVersioning(src.bucket);
      await ready();
      try {
        await s3.send(new CopyObjectCommand({ Bucket: to, Key: dst.key, CopySource: copySource(from, src.key, src.versionId), MetadataDirective: 'COPY', ...sseParams() }));
      } catch (e) {
        throw s3Error(e, `copy ${src.bucket}/${src.key}`);
      }
    },

    async delete(bucket, keys) {
      const Bucket = name(bucket);
      const objects = keys.map((k) => (typeof k === 'string' ? { Key: checkKey(k) } : { Key: checkKey(k.key), VersionId: k.versionId }));
      if (objects.length === 0) return;
      if (objects.some((x) => 'VersionId' in x)) await needVersioning(bucket);
      await ready();
      for (let i = 0; i < objects.length; i += 1000) {
        let r;
        try {
          r = await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects.slice(i, i + 1000), Quiet: true } }));
        } catch (e) {
          throw s3Error(e, `delete from ${bucket}`);
        }
        const failed = (r.Errors ?? []).filter((x) => x.Code !== 'NoSuchKey');
        if (failed.length > 0) throw new PortError('unavailable', `delete from ${bucket}: ${failed.length} keys failed (${failed[0]?.Code ?? 'error'})`);
      }
    },

    async capabilities(): Promise<StorageCapabilities> {
      const [objectLock, versioning] = await Promise.all([locked('audit'), versioned('uploads')]);
      return { objectLock, versioning, sse: o.sse !== undefined };
    },

    async ensureBuckets(e = {}) {
      await ready();
      const versionedBuckets = e.versioned ?? ['uploads', 'assets'];
      for (const b of BUCKET_NAMES) {
        const Bucket = name(b);
        const lock = b === 'audit' && e.objectLockAudit === true;
        try {
          await s3.send(new HeadBucketCommand({ Bucket }));
        } catch (err) {
          if (!(err instanceof S3ServiceException) || err.$metadata.httpStatusCode !== 404) throw s3Error(err, `head bucket ${b}`);
          try {
            await s3.send(new CreateBucketCommand({ Bucket, ...(lock ? { ObjectLockEnabledForBucket: true } : {}) }));
          } catch (c) {
            throw s3Error(c, `create bucket ${b}`);
          }
        }
        if (versionedBuckets.includes(b) && !lock) {
          try {
            await s3.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: 'Enabled' } }));
          } catch (v) {
            throw s3Error(v, `versioning of ${b}`);
          }
        }
      }
      probes.clear();
    },
  };
}
