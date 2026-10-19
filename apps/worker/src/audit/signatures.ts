import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { checkpointMessage, type CheckpointAlg, type CheckpointStatement, type StoredCheckpoint } from '@form/db';
import type { KeyProvider } from '@form/ports';

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/** A KMS public key in the port's wire format (Ed25519: 32 raw bytes; ES256: 65-byte SEC1 point) as a KeyObject. */
export function publicKeyObject(alg: CheckpointAlg, raw: Uint8Array): KeyObject {
  if (alg === 'ed25519') {
    if (raw.byteLength !== 32) throw new Error('an Ed25519 public key is 32 bytes');
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(raw) }, format: 'jwk' });
  }
  if (raw.byteLength !== 65 || raw[0] !== 4) throw new Error('an ES256 public key is a 65-byte uncompressed point');
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33)) }, format: 'jwk' });
}

/**
 * Signs and verifies checkpoints through the KMS port (architecture §2.7: an app-held Ed25519 key wrapped by the
 * KMS, or ES256 where policy wants a KMS-native signature). Only `keyId` and the retired audit keys verify: a
 * checkpoint under any other key the KMS knows fails. Public keys are cached per key id for one run.
 */
export function checkpointSigner(keys: KeyProvider, keyId: string, retiredKeyIds: readonly string[] = []) {
  const accepted = new Set([keyId, ...retiredKeyIds]);
  const cache = new Map<string, Promise<{ alg: CheckpointAlg; key: KeyObject }>>();
  const pub = (id: string) => {
    let p = cache.get(id);
    if (!p) {
      p = keys.publicKey(id).then((k) => ({ alg: k.alg, key: publicKeyObject(k.alg, k.key) }));
      cache.set(id, p);
    }
    return p;
  };

  return {
    keyId,
    async sign(s: Omit<CheckpointStatement, 'keyId' | 'alg'>): Promise<StoredCheckpoint> {
      const { alg } = await pub(keyId);
      const statement: CheckpointStatement = { ...s, keyId, alg };
      const signed = await keys.sign(keyId, checkpointMessage(statement));
      if (signed.alg !== alg) throw new Error(`audit.checkpoint: ${keyId} signed with ${signed.alg}, its public key is ${alg}`);
      return { ...statement, signature: signed.signature };
    },
    async verify(cp: StoredCheckpoint): Promise<boolean> {
      if (!accepted.has(cp.keyId)) return false;
      let k: { alg: CheckpointAlg; key: KeyObject };
      try {
        k = await pub(cp.keyId);
      } catch {
        return false;
      }
      if (k.alg !== cp.alg) return false;
      const message = checkpointMessage(cp);
      return cp.alg === 'ed25519'
        ? verify(null, message, k.key, cp.signature)
        : verify('sha256', message, { key: k.key, dsaEncoding: 'ieee-p1363' }, cp.signature);
    },
  };
}

export type CheckpointSigner = ReturnType<typeof checkpointSigner>;
