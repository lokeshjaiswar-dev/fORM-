import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { KeyProvider, SignatureAlg } from '@form/ports';
import { expectPortError, useSubject, utf8, type ContractSetup, type ContractSubject } from './contract.ts';

const ALGS: Record<SignatureAlg, { key: number; signature: number }> = {
  ed25519: { key: 32, signature: 64 },
  es256: { key: 65, signature: 64 },
};

/** Verifies with WebCrypto, independently of the implementation under test. */
export async function verifySignature(alg: SignatureAlg, publicKey: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  const { subtle } = webcrypto;
  if (alg === 'ed25519') {
    const k = await subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    return subtle.verify({ name: 'Ed25519' }, k, signature, data);
  }
  const k = await subtle.importKey('raw', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, signature, data);
}

const dek = () => webcrypto.getRandomValues(new Uint8Array(32));
const ORG = { orgId: '0190f1d2-0000-7000-8000-000000000001' };
const OTHER_ORG = { orgId: '0190f1d2-0000-7000-8000-000000000002' };

export function runKeyProviderContract(label: string, setup: ContractSetup<ContractSubject<KeyProvider>>): void {
  describe(`KeyProvider contract: ${label}`, () => {
    const subject = useSubject(setup);
    const kms = () => subject().impl;

    it('wraps and unwraps a data key for its org', async () => {
      const key = dek();
      const { wrapped, kekRef } = await kms().wrap(key, ORG);
      expect(kekRef).toEqual(expect.any(String));
      expect(kekRef.length).toBeGreaterThan(0);
      expect(Buffer.from(wrapped).includes(Buffer.from(key))).toBe(false);
      expect(await kms().unwrap(wrapped, kekRef, ORG)).toEqual(key);
    });

    it('wraps the same key differently each time', async () => {
      const key = dek();
      const a = await kms().wrap(key, ORG);
      const b = await kms().wrap(key, ORG);
      expect(Buffer.from(a.wrapped).equals(Buffer.from(b.wrapped))).toBe(false);
    });

    it('binds the org into the wrap', async () => {
      const { wrapped, kekRef } = await kms().wrap(dek(), ORG);
      await expectPortError(kms().unwrap(wrapped, kekRef, OTHER_ORG), 'integrity');
    });

    it('detects tampering', async () => {
      const { wrapped, kekRef } = await kms().wrap(dek(), ORG);
      const tampered = Uint8Array.from(wrapped);
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
      await expectPortError(kms().unwrap(tampered, kekRef, ORG), 'integrity');
      await expectPortError(kms().unwrap(wrapped.subarray(0, 8), kekRef, ORG), 'integrity', 'invalid_argument');
    });

    it('rejects a key-encryption key it does not hold', async () => {
      const { wrapped } = await kms().wrap(dek(), ORG);
      await expectPortError(kms().unwrap(wrapped, 'unknown-kek', ORG), 'not_found', 'invalid_argument');
    });

    it('refuses to wrap nothing', async () => {
      await expectPortError(kms().wrap(new Uint8Array(0), ORG), 'invalid_argument');
    });

    it('signs with a stable public key that WebCrypto verifies', async () => {
      const data = utf8('checkpoint|org|42|abcd');
      const sig = await kms().sign('audit-platform', data);
      const pub = await kms().publicKey('audit-platform');
      expect(sig.alg).toBe(pub.alg);
      expect(pub.key.byteLength).toBe(ALGS[pub.alg].key);
      expect(sig.signature.byteLength).toBe(ALGS[sig.alg].signature);
      expect(await verifySignature(pub.alg, pub.key, sig.signature, data)).toBe(true);
      expect(await verifySignature(pub.alg, pub.key, sig.signature, utf8('checkpoint|org|43|abcd'))).toBe(false);
      expect((await kms().publicKey('audit-platform')).key).toEqual(pub.key);
    });

    it('keeps signing keys apart', async () => {
      const a = await kms().publicKey('audit-platform');
      const b = await kms().publicKey('templates-system');
      expect(Buffer.from(a.key).equals(Buffer.from(b.key))).toBe(false);
      const sig = await kms().sign('templates-system', utf8('x'));
      expect(await verifySignature(a.alg, a.key, sig.signature, utf8('x'))).toBe(false);
    });

    it('rejects an empty key id', async () => {
      await expectPortError(kms().sign('', utf8('x')), 'invalid_argument');
      await expectPortError(kms().publicKey(''), 'invalid_argument');
    });
  });
}
