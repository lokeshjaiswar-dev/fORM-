import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUCKET_NAMES, type BucketName } from '@form/ports';
import { collectBytes, expectPortError, runStorageContract, s3PresignedClient, startSeaweedFs, utf8, type SeaweedFs } from '@form/testkit';
import { createEgressGuard } from '../src/egress/index.ts';
import { createS3Storage, type S3Storage } from '../src/storage/index.ts';

const egress = createEgressGuard({ policy: 'allowlist', allowlist: ['127.0.0.1', 'localhost'] });
const buckets = (prefix: string) => Object.fromEntries(BUCKET_NAMES.map((b) => [b, `${prefix}-${b}`])) as Record<BucketName, string>;

let s3: SeaweedFs;
beforeAll(async () => {
  s3 = await startSeaweedFs();
});
afterAll(() => s3?.stop());

async function store(o: { objectLockAudit: boolean; versioned?: BucketName[] }): Promise<S3Storage> {
  const storage = createS3Storage({
    region: 'us-east-1',
    endpoint: s3.endpoint,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
    buckets: buckets(`fr${randomBytes(4).toString('hex')}`),
    egress,
  });
  await storage.ensureBuckets(o);
  return storage;
}

runStorageContract('S3 → SeaweedFS, audit bucket with Object Lock', async () => ({
  impl: await store({ objectLockAudit: true }),
  presigned: s3PresignedClient(),
}));

runStorageContract('S3 → SeaweedFS, no Object Lock, no versioning', async () => ({
  impl: await store({ objectLockAudit: false, versioned: [] }),
  presigned: s3PresignedClient(),
}));

describe('S3 storage on SeaweedFS', () => {
  it('reports the capabilities the buckets really have', async () => {
    expect(await (await store({ objectLockAudit: true })).capabilities()).toEqual({ objectLock: true, versioning: true, sse: false });
    expect(await (await store({ objectLockAudit: false, versioned: [] })).capabilities()).toEqual({ objectLock: false, versioning: false, sse: false });
  });

  it('writes compliance-locked objects, and only to a bucket with Object Lock', async () => {
    const storage = await store({ objectLockAudit: true });
    const retainUntil = new Date(Date.now() + 24 * 3600_000);
    await storage.put('audit', 'checkpoints/org/1.json', utf8('{"seq":1}'), { contentType: 'application/json', objectLock: { mode: 'compliance', retainUntil } });
    expect(new TextDecoder().decode(await collectBytes(await storage.get('audit', 'checkpoints/org/1.json')))).toBe('{"seq":1}');
    await expectPortError(storage.put('uploads', 'x', utf8('x'), { contentType: 'text/plain', objectLock: { mode: 'compliance', retainUntil } }), 'unsupported');
  });

  it('streams a multipart upload', async () => {
    const storage = createS3Storage({
      region: 'us-east-1',
      endpoint: s3.endpoint,
      credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
      buckets: buckets(`fr${randomBytes(4).toString('hex')}`),
      egress,
      partBytes: 5 * 1024 * 1024,
    });
    await storage.ensureBuckets();
    const chunk = randomBytes(1024 * 1024);
    async function* body() {
      for (let i = 0; i < 12; i++) yield new Uint8Array(chunk);
    }
    await storage.put('exports', 'big.bin', body(), { contentType: 'application/octet-stream' });
    expect((await storage.head('exports', 'big.bin'))?.bytes).toBe(12 * 1024 * 1024);
  });

  it('refuses presigned POST and GET URLs once they expire', async () => {
    // SeaweedFS's clock cannot be moved, so the contract's `expires` case skips; this waits out a 1 s expiry instead.
    const storage = await store({ objectLockAudit: false, versioned: [] });
    const client = s3PresignedClient();
    await storage.put('uploads', 'late.txt', utf8('late'), { contentType: 'text/plain' });
    const post = await storage.presignPost({ bucket: 'staging', key: 'late.png', contentType: 'image/png', minBytes: 1, maxBytes: 8, expiresSec: 1 });
    const get = await storage.presignGet({ bucket: 'uploads', key: 'late.txt', expiresSec: 1 });
    expect(new TextDecoder().decode(await client.download(get))).toBe('late');
    await new Promise((r) => setTimeout(r, 2500));
    await expectPortError(client.upload(post, new Uint8Array(4), 'image/png'), 'expired');
    await expectPortError(client.download(get), 'expired');
    expect(await storage.head('staging', 'late.png')).toBeNull();
  });

  it('never connects to a store the egress guard denies', async () => {
    const denied = createS3Storage({
      region: 'us-east-1',
      endpoint: s3.endpoint,
      credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
      buckets: buckets('frdenied'),
      egress: createEgressGuard({ policy: 'none', allowlist: [] }),
    });
    await expectPortError(denied.head('uploads', 'x'), 'egress_denied');
  });
});
