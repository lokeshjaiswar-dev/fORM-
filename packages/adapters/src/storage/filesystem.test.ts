import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectBytes, expectPortError, runStorageContract, utf8 } from '@form/testkit';
import { createFilesystemStorage, type FilesystemStorage } from './filesystem.ts';

const signingKey = utf8('dev-signing-key-0123456789abcdef!');
const publicUrl = 'http://localhost:8080/_dev/storage';

async function tempStore(now?: () => number): Promise<{ storage: FilesystemStorage; root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'form-fs-storage-'));
  const storage = createFilesystemStorage({ root, publicUrl, signingKey, ...(now ? { now } : {}) });
  return { storage, root, dispose: () => rm(root, { recursive: true, force: true }) };
}

runStorageContract('filesystem', async () => {
  let offset = 0;
  const { storage, dispose } = await tempStore(() => Date.now() + offset);
  return {
    impl: storage,
    dispose,
    presigned: {
      upload: async (post, body, contentType) => {
        await storage.acceptPresignedPost(post.url.slice(post.url.lastIndexOf('/') + 1), post.fields, { body, contentType });
      },
      download: async (url) => {
        const { bucket, key } = await storage.resolvePresignedGet(url);
        return collectBytes(await storage.get(bucket, key));
      },
      advanceClock: (ms) => {
        offset += ms;
      },
    },
  };
});

describe('filesystem storage', () => {
  let clock = Date.parse('2027-01-01T00:00:00Z');
  let store: Awaited<ReturnType<typeof tempStore>>;
  const s = () => store.storage;

  beforeAll(async () => {
    store = await tempStore(() => clock);
  });
  afterAll(() => store.dispose());

  it('validates its options', () => {
    expect(() => createFilesystemStorage({ root: '.', publicUrl, signingKey: new Uint8Array(8) })).toThrow(/32 bytes/);
    expect(() => createFilesystemStorage({ root: '.', publicUrl: 'ftp://x', signingKey })).toThrow(/http/);
  });

  it('never turns a key into a path', async () => {
    await s().put('uploads', 'u/org/form/2027/01/file', utf8('x'), { contentType: 'text/plain' });
    const names = await readdir(path.join(store.root, 'uploads'));
    expect(names.every((n) => /^[0-9a-f]{64}(\.json)?$/.test(n))).toBe(true);
  });

  it('keeps a key and its prefix apart', async () => {
    await s().put('uploads', 'a', utf8('file'), { contentType: 'text/plain' });
    await s().put('uploads', 'a/b', utf8('child'), { contentType: 'text/plain' });
    expect(new TextDecoder().decode(await collectBytes(await s().get('uploads', 'a')))).toBe('file');
  });

  it('rejects unknown buckets', async () => {
    await expectPortError(s().head('nope' as 'uploads', 'k'), 'invalid_argument');
  });

  describe('presigned POST', () => {
    const upload = async (o: { body?: string; contentType?: string; fields?: Record<string, string>; bucket?: string } = {}) => {
      const post = await s().presignPost({ bucket: 'staging', key: 'u/1/f1', contentType: 'image/png', minBytes: 1, maxBytes: 8, expiresSec: 600 });
      return s().acceptPresignedPost(o.bucket ?? 'staging', { ...post.fields, ...o.fields }, { body: utf8(o.body ?? 'png!'), contentType: o.contentType ?? 'image/png' });
    };

    it('posts to the bucket URL and stores an accepted upload', async () => {
      const post = await s().presignPost({ bucket: 'staging', key: 'u/1/f1', contentType: 'image/png', minBytes: 1, maxBytes: 8, expiresSec: 600 });
      expect(post.url).toBe(`${publicUrl}/staging`);
      expect(await upload()).toEqual({ key: 'u/1/f1' });
      expect(await s().head('staging', 'u/1/f1')).toMatchObject({ bytes: 4, contentType: 'image/png' });
    });

    it('applies the policy tags, keeps them on copy and clears them on put', async () => {
      const post = await s().presignPost({ bucket: 'staging', key: 'u/1/tagged', contentType: 'image/png', minBytes: 1, maxBytes: 8, expiresSec: 600, tags: { scan: 'pending' } });
      await s().acceptPresignedPost('staging', post.fields, { body: utf8('png!'), contentType: 'image/png' });
      expect(await s().objectTags('staging', 'u/1/tagged')).toEqual({ scan: 'pending' });
      await s().copy({ bucket: 'staging', key: 'u/1/tagged' }, { bucket: 'uploads', key: 'u/1/tagged' });
      expect(await s().objectTags('uploads', 'u/1/tagged')).toEqual({ scan: 'pending' });
      await s().put('staging', 'u/1/tagged', utf8('new'), { contentType: 'image/png' });
      expect(await s().objectTags('staging', 'u/1/tagged')).toEqual({});
      expect(await s().objectTags('staging', 'u/1/none')).toBeNull();
    });

    it('enforces the size range and content type', async () => {
      await expectPortError(upload({ body: '' }), 'invalid_argument');
      await expectPortError(upload({ body: '123456789' }), 'invalid_argument');
      await expectPortError(upload({ contentType: 'text/html' }), 'invalid_argument');
    });

    it('rejects tampering and other buckets', async () => {
      await expectPortError(upload({ fields: { key: 'u/1/other' } }), 'invalid_argument');
      await expectPortError(upload({ bucket: 'uploads' }), 'invalid_argument');
      await expectPortError(upload({ fields: { 'x-fr-signature': 'forged' } }), 'integrity');
      const post = await s().presignPost({ bucket: 'staging', key: 'u/1/f1', contentType: 'image/png', minBytes: 1, maxBytes: 8, expiresSec: 600 });
      const policy = JSON.parse(Buffer.from(post.fields.policy ?? '', 'base64url').toString()) as Record<string, unknown>;
      const widened = Buffer.from(JSON.stringify({ ...policy, max: 1e9 })).toString('base64url');
      await expectPortError(upload({ fields: { policy: widened } }), 'integrity');
    });

    it('expires', async () => {
      const post = await s().presignPost({ bucket: 'staging', key: 'u/1/f2', contentType: 'image/png', minBytes: 1, maxBytes: 8, expiresSec: 60 });
      clock += 61_000;
      await expectPortError(s().acceptPresignedPost('staging', post.fields, { body: utf8('png!'), contentType: 'image/png' }), 'expired');
    });
  });

  describe('presigned GET', () => {
    it('resolves its own URLs', async () => {
      const url = await s().presignGet({ bucket: 'uploads', key: 'u/org/form/f_1', expiresSec: 60, downloadName: 'Résumé.pdf' });
      expect(await s().resolvePresignedGet(url)).toEqual({ bucket: 'uploads', key: 'u/org/form/f_1', downloadName: 'Résumé.pdf' });
      const plain = await s().presignGet({ bucket: 'exports', key: 'e/1', expiresSec: 60 });
      expect(await s().resolvePresignedGet(plain)).toEqual({ bucket: 'exports', key: 'e/1' });
    });

    it('rejects edited, foreign and expired URLs', async () => {
      const url = new URL(await s().presignGet({ bucket: 'uploads', key: 'u/1', expiresSec: 60, downloadName: 'a.pdf' }));
      const edited = new URL(url);
      edited.searchParams.set('dl', 'b.pdf');
      await expectPortError(s().resolvePresignedGet(edited.href), 'integrity');
      await expectPortError(s().resolvePresignedGet(url.href.replace('/uploads/', '/exports/')), 'integrity');
      await expectPortError(s().resolvePresignedGet('http://elsewhere.test/_dev/storage/uploads/u%2F1'), 'invalid_argument');
      await expectPortError(s().resolvePresignedGet(`${publicUrl}/uploads`), 'invalid_argument');
      await expectPortError(s().resolvePresignedGet(`${publicUrl}/uploads/%E0`), 'invalid_argument');
      await expectPortError(s().resolvePresignedGet('not a url'), 'invalid_argument');
      const plain = await s().presignGet({ bucket: 'uploads', key: 'u/1', expiresSec: 60 });
      await expectPortError(s().resolvePresignedGet(`${plain}&dl=`), 'integrity');
      await expectPortError(s().presignGet({ bucket: 'uploads', key: 'u/1', expiresSec: 60, downloadName: 'a"b' }), 'invalid_argument');
      clock += 61_000;
      await expectPortError(s().resolvePresignedGet(url.href), 'expired');
    });
  });

  it('refuses versioned copies', async () => {
    await expectPortError(s().copy({ bucket: 'uploads', key: 'a', versionId: 'v' }, { bucket: 'assets', key: 'a' }), 'unsupported');
  });

  it('cleans up when a stream body fails', async () => {
    async function* failing() {
      yield utf8('partial');
      throw new Error('client went away');
    }
    await expect(s().put('uploads', 'broken', failing(), { contentType: 'text/plain' })).rejects.toThrow('client went away');
    expect(await s().head('uploads', 'broken')).toBeNull();
    expect(await readdir(path.join(store.root, '.tmp'))).toEqual([]);
  });

  it('cleans up when a commit fails', async () => {
    await writeFile(path.join(store.root, 'packs'), 'not a directory');
    await expect(s().put('packs', 'p/1', utf8('x'), { contentType: 'text/plain' })).rejects.toThrow();
    expect(await readdir(path.join(store.root, '.tmp'))).toEqual([]);
  });
});
