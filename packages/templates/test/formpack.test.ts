import { createHash, generateKeyPairSync } from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  DEV_TRUSTED_KEY, FORMPACK_LIMITS, FormpackError, buildFormpack, readFormpack, verifySignature, type FormpackErrorCode, type PackSigner, type TrustedKey,
} from '../src/index.ts';
import { devSigner, keySigner, trustedKeyOf } from '../scripts/signer.ts';
import { flipByte, rezip, systemCore } from './helpers.ts';

async function pack(signer: PackSigner = devSigner()): Promise<Uint8Array> {
  const result = await buildFormpack(systemCore(), signer);
  if (!result.ok) throw new Error('system-core does not build');
  return result.bytes;
}

const TRUSTED = { trustedKeys: [DEV_TRUSTED_KEY] };

async function code(bytes: Uint8Array, options = TRUSTED): Promise<FormpackErrorCode | 'ok'> {
  try {
    await readFormpack(bytes, options);
    return 'ok';
  } catch (e) {
    if (e instanceof FormpackError) return e.code;
    throw e;
  }
}

describe('readFormpack verification', () => {
  it('rejects one changed byte in any file of the pack', async () => {
    const bytes = await pack();
    const files = unzipSync(bytes);
    const expected: Record<string, FormpackErrorCode[]> = {
      'manifest.json': ['bad_signature', 'manifest_invalid'],
      'signature.json': ['bad_signature', 'signature_invalid'],
    };
    expect(Object.keys(files)).toHaveLength(8);
    for (const [path, content] of Object.entries(files)) {
      for (const at of [0, Math.floor(content.length / 2), content.length - 2]) {
        const tampered = rezip(bytes, (f) => { f[path] = flipByte(content, at); });
        expect(expected[path] ?? ['hash_mismatch'], `${path}@${at}`).toContain(await code(tampered));
      }
    }
    expect(await code(rezip(bytes, () => {}))).toBe('ok');
  });

  it('rejects a manifest re-signed by another key under the trusted key id', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(await code(await pack(keySigner(DEV_TRUSTED_KEY.keyId, privateKey)))).toBe('bad_signature');
  });

  it('needs a trusted key of the algorithm the signature names', async () => {
    const bytes = await pack();
    expect(await code(bytes, { trustedKeys: [] })).toBe('untrusted_key');
    expect(await code(bytes, { trustedKeys: [{ ...DEV_TRUSTED_KEY, alg: 'es256' }] })).toBe('algorithm_mismatch');
    expect(await code(bytes, { trustedKeys: [{ ...DEV_TRUSTED_KEY, publicKey: '***' }] })).toBe('signature_invalid');
  });

  it('verifies an ES256 pack with its P-256 key (per-key algorithm)', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const key: TrustedKey = trustedKeyOf('acme-legal-2026', privateKey);
    expect(key.alg).toBe('es256');
    const bytes = await pack(keySigner('acme-legal-2026', privateKey));
    const read = await readFormpack(bytes, { trustedKeys: [DEV_TRUSTED_KEY, key] });
    expect(read.signature).toMatchObject({ alg: 'es256', keyId: 'acme-legal-2026' });
    expect(await code(bytes, { trustedKeys: [{ ...key, alg: 'ed25519' }] })).toBe('algorithm_mismatch');
  });

  it('refuses keys of other types', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    expect(() => keySigner('rsa', privateKey)).toThrow(/Ed25519 or P-256/);
  });

  it('rejects unlisted, missing and unsafe files', async () => {
    const bytes = await pack();
    expect(await code(rezip(bytes, (f) => { f['templates/core/extra.v1.json'] = new Uint8Array([123, 125]); }))).toBe('unlisted_file');
    expect(await code(rezip(bytes, (f) => { delete f['categories.json']; }))).toBe('missing_file');
    expect(await code(rezip(bytes, (f) => { delete f['manifest.json']; }))).toBe('missing_file');
    expect(await code(rezip(bytes, (f) => { f['../evil.json'] = new Uint8Array([1]); }))).toBe('unsafe_path');
    expect(await code(rezip(bytes, (f) => { f['C:/evil.json'] = new Uint8Array([1]); }))).toBe('unsafe_path');
    expect(await code(rezip(bytes, (f) => { f['templates/a\u0001.json'] = new Uint8Array([1]); }))).toBe('unsafe_path');
    expect(await code(rezip(bytes, (f) => { f['assets/'] = new Uint8Array(); }))).toBe('ok');
  });

  it('applies the zip guards before inflating', async () => {
    expect(await code(new Uint8Array([1, 2, 3, 4]))).toBe('invalid_zip');
    expect(await code(new Uint8Array(FORMPACK_LIMITS.packBytes + 1))).toBe('too_large');
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i <= FORMPACK_LIMITS.files; i += 1) many[`f${i}`] = new Uint8Array([i % 256]);
    expect(await code(zipSync(many))).toBe('too_large');
    expect(await code(zipSync({ 'bomb.json': new Uint8Array(4 * 1024 * 1024) }))).toBe('too_large');
  });

  it('reports a manifest or signature that is not JSON of its shape', async () => {
    const bytes = await pack();
    const text = (s: string) => new TextEncoder().encode(s);
    expect(await code(rezip(bytes, (f) => { f['signature.json'] = text('{"alg":"rsa","keyId":"k","sig":"x"}'); }))).toBe('signature_invalid');
    expect(await code(rezip(bytes, (f) => { f['manifest.json'] = text('{"format":"zip"}'); }))).toBe('manifest_invalid');
    expect(await code(rezip(bytes, (f) => { f['manifest.json'] = new Uint8Array([0xff, 0xfe]); }))).toBe('manifest_invalid');
  });

  it('returns false for a signature it cannot check', async () => {
    expect(await verifySignature('ed25519', new Uint8Array(3), new Uint8Array(64), new Uint8Array(1))).toBe(false);
    expect(await verifySignature('es256', new Uint8Array(65), new Uint8Array(64), new Uint8Array(1))).toBe(false);
  });
});

describe('pack bytes', () => {
  /** The system-core pack signed with the dev key. A template, category or format change moves it; a time zone must not (BL-119). */
  const SYSTEM_CORE_SHA256 = '8ca759eeaf23bb893e807628f49387f01aa52d6f7cc8f1554df9dbab3ef2b64c';
  const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

  it('are the same in every time zone', async () => {
    const tz = process.env.TZ;
    try {
      for (const zone of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
        process.env.TZ = zone;
        expect(sha256(await pack()), zone).toBe(SYSTEM_CORE_SHA256);
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});
