import { describe, expect, it } from 'vitest';
import { MAX_OBJECT_TAGS, MAX_PRESIGN_EXPIRES_SEC, type PresignedPost, type Storage } from '@form/ports';
import {
  collectBytes,
  expectPortError,
  trackedStream,
  uniquePrefix,
  useSubject,
  utf8,
  type ContractSetup,
  type ContractSubject,
} from './contract.ts';

const BAD_KEYS = ['../escape', '/absolute', 'a//b', 'a/./b', '.hidden', 'sp ace'];
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * Does what a browser does with presigned URLs, against whatever serves them (S3 itself, or the dev
 * endpoint). A refusal rejects with the PortError it maps to: outside the policy (size, content type, key)
 * -> invalid_argument, a forged or edited signature -> integrity, past expiry -> expired. Any other error fails
 * the case, so a broken harness or an I/O failure cannot pass for a refusal.
 */
export interface PresignedClient {
  upload(post: PresignedPost, body: Uint8Array, contentType: string): Promise<void>;
  download(url: string): Promise<Uint8Array>;
  /** Moves the store's clock by `ms` (negative moves it back), when it has one to move; the expiry case runs only then. */
  advanceClock?(ms: number): void;
}

export interface StorageContractSubject extends ContractSubject<Storage> {
  /** When given, the contract also proves what presigned URLs enforce: size range, content type, key binding, tampering, expiry. */
  presigned?: PresignedClient;
}

/** Behaviour every Storage implementation shares (architecture §6). Real stores get a fresh key prefix per run. */
export function runStorageContract(label: string, setup: ContractSetup<StorageContractSubject>): void {
  describe(`Storage contract: ${label}`, () => {
    const subject = useSubject(setup);
    const s = () => subject().impl;
    const prefix = uniquePrefix();
    const key = (name: string) => `${prefix}/${name}`;

    it('round-trips bytes and metadata', async () => {
      const k = key('round-trip.txt');
      await s().put('uploads', k, utf8('hello, नमस्ते'), { contentType: 'text/plain; charset=utf-8' });
      const head = await s().head('uploads', k);
      expect(head).toMatchObject({ bytes: utf8('hello, नमस्ते').byteLength, contentType: 'text/plain; charset=utf-8' });
      expect(head?.etag).toEqual(expect.any(String));
      expect(decode(await collectBytes(await s().get('uploads', k)))).toBe('hello, नमस्ते');
    });

    it('accepts a stream body and drains it', async () => {
      const k = key('nested/dir/streamed.bin');
      const chunks = [utf8('ab'), utf8('cd'), utf8('ef')];
      const { stream, consumed } = trackedStream(chunks);
      await s().put('staging', k, stream, { contentType: 'application/octet-stream' });
      expect(consumed()).toBe(3);
      expect(decode(await collectBytes(await s().get('staging', k)))).toBe('abcdef');
    });

    it('stores empty objects', async () => {
      const k = key('empty');
      await s().put('assets', k, new Uint8Array(0), { contentType: 'application/octet-stream' });
      expect((await s().head('assets', k))?.bytes).toBe(0);
      expect((await collectBytes(await s().get('assets', k))).byteLength).toBe(0);
    });

    it('reports missing objects', async () => {
      expect(await s().head('uploads', key('missing'))).toBeNull();
      await expectPortError(s().get('uploads', key('missing')), 'not_found');
    });

    it('keeps buckets apart', async () => {
      const k = key('bucket-scoped');
      await s().put('exports', k, utf8('x'), { contentType: 'text/plain' });
      expect(await s().head('assets', k)).toBeNull();
    });

    it('replaces content and changes the etag on overwrite', async () => {
      const k = key('overwrite');
      await s().put('uploads', k, utf8('one'), { contentType: 'text/plain' });
      const first = await s().head('uploads', k);
      await s().put('uploads', k, utf8('two!'), { contentType: 'application/json' });
      const second = await s().head('uploads', k);
      expect(second).toMatchObject({ bytes: 4, contentType: 'application/json' });
      expect(second?.etag).not.toBe(first?.etag);
      expect(decode(await collectBytes(await s().get('uploads', k)))).toBe('two!');
    });

    it('reads inclusive byte ranges and clamps the end', async () => {
      const k = key('range');
      await s().put('uploads', k, utf8('0123456789'), { contentType: 'text/plain' });
      expect(decode(await collectBytes(await s().get('uploads', k, { start: 2, end: 5 })))).toBe('2345');
      expect(decode(await collectBytes(await s().get('uploads', k, { start: 7, end: 100 })))).toBe('789');
      await expectPortError(s().get('uploads', k, { start: 10, end: 12 }), 'invalid_argument');
      await expectPortError(s().get('uploads', k, { start: 5, end: 4 }), 'invalid_argument');
      await expectPortError(s().get('uploads', k, { start: -1, end: 4 }), 'invalid_argument');
    });

    it('copies across buckets', async () => {
      const src = key('copy-src');
      const dst = key('copy-dst');
      await s().put('staging', src, utf8('scanned'), { contentType: 'image/png' });
      await s().copy({ bucket: 'staging', key: src }, { bucket: 'uploads', key: dst });
      expect(await s().head('uploads', dst)).toMatchObject({ bytes: 7, contentType: 'image/png' });
      expect(decode(await collectBytes(await s().get('uploads', dst)))).toBe('scanned');
      expect(await s().head('staging', src)).not.toBeNull();
      await expectPortError(s().copy({ bucket: 'staging', key: key('nope') }, { bucket: 'uploads', key: dst }), 'not_found');
    });

    it('deletes many keys and ignores missing ones', async () => {
      const a = key('del-a');
      const b = key('del/b');
      await s().put('exports', a, utf8('a'), { contentType: 'text/plain' });
      await s().put('exports', b, utf8('b'), { contentType: 'text/plain' });
      await s().delete('exports', [a, b, key('del-never-existed')]);
      expect(await s().head('exports', a)).toBeNull();
      expect(await s().head('exports', b)).toBeNull();
      await s().delete('exports', []);
    });

    it.each(BAD_KEYS)('rejects the unsafe key %j everywhere', async (bad) => {
      await expectPortError(s().put('uploads', bad, utf8('x'), { contentType: 'text/plain' }), 'invalid_argument');
      await expectPortError(s().head('uploads', bad), 'invalid_argument');
      await expectPortError(s().get('uploads', bad), 'invalid_argument');
      await expectPortError(s().delete('uploads', [bad]), 'invalid_argument');
      await expectPortError(s().copy({ bucket: 'uploads', key: bad }, { bucket: 'assets', key: key('copy-bad') }), 'invalid_argument');
      await expectPortError(s().copy({ bucket: 'uploads', key: key('copy-bad') }, { bucket: 'assets', key: bad }), 'invalid_argument');
      await expectPortError(s().presignGet({ bucket: 'uploads', key: bad, expiresSec: 60 }), 'invalid_argument');
      await expectPortError(
        s().presignPost({ bucket: 'staging', key: bad, contentType: 'image/png', minBytes: 0, maxBytes: 10, expiresSec: 60 }),
        'invalid_argument',
      );
    });

    it('never silently drops object lock, SSE or version requests it cannot honour', async () => {
      const caps = await s().capabilities();
      expect(caps).toEqual({ objectLock: expect.any(Boolean), versioning: expect.any(Boolean), sse: expect.any(Boolean) });
      const k = key('caps');
      const retainUntil = new Date(Date.now() + 60_000);
      if (!caps.objectLock) {
        await expectPortError(s().put('audit', k, utf8('x'), { contentType: 'text/plain', objectLock: { mode: 'compliance', retainUntil } }), 'unsupported');
        expect(await s().head('audit', k)).toBeNull();
      }
      if (!caps.sse) {
        await expectPortError(s().put('uploads', k, utf8('x'), { contentType: 'text/plain', sse: true }), 'unsupported');
      }
      if (!caps.versioning) {
        await expectPortError(s().delete('uploads', [{ key: k, versionId: 'v1' }]), 'unsupported');
      }
    });

    it('presigns a POST upload', async () => {
      const k = key('presigned-post');
      const post = await s().presignPost({ bucket: 'staging', key: k, contentType: 'image/jpeg', minBytes: 1, maxBytes: 1024, expiresSec: 600 });
      expect(new URL(post.url).protocol).toMatch(/^https?:$/);
      expect(post.fields).toMatchObject({ key: k, 'Content-Type': 'image/jpeg' });
    });

    it('validates presign arguments', async () => {
      const base = { bucket: 'staging', key: key('p'), contentType: 'image/jpeg', minBytes: 0, maxBytes: 10, expiresSec: 60 } as const;
      await expectPortError(s().presignPost({ ...base, expiresSec: 0 }), 'invalid_argument');
      await expectPortError(s().presignPost({ ...base, expiresSec: MAX_PRESIGN_EXPIRES_SEC + 1 }), 'invalid_argument');
      await expectPortError(s().presignPost({ ...base, minBytes: 11 }), 'invalid_argument');
      await expectPortError(s().presignPost({ ...base, minBytes: -1 }), 'invalid_argument');
      await expectPortError(s().presignPost({ ...base, contentType: 'text/plain\r\nX-Evil: 1' }), 'invalid_argument');
      await expectPortError(s().presignGet({ bucket: 'uploads', key: key('g'), expiresSec: 0 }), 'invalid_argument');
      const tooMany = Object.fromEntries(Array.from({ length: MAX_OBJECT_TAGS + 1 }, (_, i) => [`t${i}`, 'v']));
      for (const tags of [tooMany, { '': 'v' }, { scan: 'a\r\nb' }, { scan: '<pending>' }, { 'aws:x': 'v' }]) {
        await expectPortError(s().presignPost({ ...base, tags }), 'invalid_argument');
      }
      await expect(s().presignPost({ ...base, tags: { scan: 'pending', 'form:id': 'f_1' } })).resolves.toBeDefined();
    });

    it('presigns distinct GET URLs per object', async () => {
      const a = await s().presignGet({ bucket: 'uploads', key: key('get-a'), expiresSec: 60 });
      const b = await s().presignGet({ bucket: 'uploads', key: key('get-b'), expiresSec: 60, downloadName: 'report.pdf' });
      expect(new URL(a).protocol).toMatch(/^https?:$/);
      expect(a).not.toBe(b);
    });

    describe('presigned URLs in use', () => {
      const client = () => subject().presigned;
      const png = (n: number) => new Uint8Array(n).fill(0x89);
      const post = (name: string, expiresSec = 600) =>
        s().presignPost({ bucket: 'staging', key: key(name), contentType: 'image/png', minBytes: 1, maxBytes: 8, expiresSec });

      it('uploads within the policy and downloads it again', async (ctx) => {
        const c = client();
        if (!c) return ctx.skip();
        await c.upload(await post('pp-ok'), png(8), 'image/png');
        expect(await s().head('staging', key('pp-ok'))).toMatchObject({ bytes: 8, contentType: 'image/png' });
        const url = await s().presignGet({ bucket: 'staging', key: key('pp-ok'), expiresSec: 60 });
        expect(await c.download(url)).toEqual(png(8));
      });

      it('enforces the size range and content type (C/F-29)', async (ctx) => {
        const c = client();
        if (!c) return ctx.skip();
        await expectPortError(c.upload(await post('pp-big'), png(9), 'image/png'), 'invalid_argument');
        await expectPortError(c.upload(await post('pp-empty'), png(0), 'image/png'), 'invalid_argument');
        await expectPortError(c.upload(await post('pp-type'), png(4), 'text/html'), 'invalid_argument');
        for (const name of ['pp-big', 'pp-empty', 'pp-type']) expect(await s().head('staging', key(name))).toBeNull();
      });

      it('binds the key and refuses tampered URLs', async (ctx) => {
        const c = client();
        if (!c) return ctx.skip();
        const p = await post('pp-bound');
        await expectPortError(c.upload({ ...p, fields: { ...p.fields, key: key('pp-elsewhere') } }, png(4), 'image/png'), 'invalid_argument');
        expect(await s().head('staging', key('pp-elsewhere'))).toBeNull();
        await s().put('uploads', key('pg-secret'), utf8('secret'), { contentType: 'text/plain' });
        await s().put('uploads', key('pg-secretx'), utf8('other'), { contentType: 'text/plain' });
        const edited = new URL(await s().presignGet({ bucket: 'uploads', key: key('pg-secret'), expiresSec: 60 }));
        edited.pathname += 'x';
        await expectPortError(c.download(edited.href), 'integrity');
      });

      it('expires', async (ctx) => {
        const c = client();
        if (!c?.advanceClock) return ctx.skip();
        const p = await post('pp-late', 60);
        await s().put('uploads', key('pg-late'), utf8('late'), { contentType: 'text/plain' });
        const url = await s().presignGet({ bucket: 'uploads', key: key('pg-late'), expiresSec: 60 });
        c.advanceClock(61_000);
        ctx.onTestFinished(() => c.advanceClock?.(-61_000));
        await expectPortError(c.upload(p, png(4), 'image/png'), 'expired');
        await expectPortError(c.download(url), 'expired');
      });
    });
  });
}
