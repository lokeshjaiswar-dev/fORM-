import { createPrivateKey, createPublicKey, hkdfSync, sign, type KeyObject } from 'node:crypto';
import { PortError, type SignatureAlg } from '@form/ports';

export const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export const invalid = (message: string) => new PortError('invalid_argument', message);
export const hkdf = (master: Uint8Array, info: string) => Buffer.from(hkdfSync('sha256', master, new Uint8Array(0), info, 32));

export function checkKeyId(keyId: string): string {
  if (!KEY_ID.test(keyId)) throw invalid(`invalid key id ${JSON.stringify(keyId)}`);
  return keyId;
}

/** The AAD every data-key wrap binds: the org, so a key unwrapped under another org fails. */
export function dekContext(orgId: string): string {
  if (orgId.length === 0) throw invalid('orgId is required');
  return `form:dek:v1|${orgId}`;
}

/** The signing half of a KeyProvider. */
export interface Signer {
  sign(keyId: string, data: Uint8Array): Promise<{ alg: SignatureAlg; signature: Uint8Array }>;
  publicKey(keyId: string): Promise<{ alg: SignatureAlg; key: Uint8Array }>;
}

/**
 * App-held Ed25519 signing keys (architecture §2.7): one per key id, derived from a 32-byte seed with HKDF, so the
 * algorithm never depends on the KMS vendor. The keyfile driver derives from its master key; the KMS drivers keep the
 * seed wrapped by the KMS (`sealSigningSeed`) and unwrap it once at boot.
 */
export function createAppSigner(seed: Uint8Array): Signer {
  if (seed.byteLength !== 32) throw invalid('a signing seed is 32 bytes');
  const master = Uint8Array.from(seed);
  const keys = new Map<string, KeyObject>();
  const key = (keyId: string): KeyObject => {
    let k = keys.get(keyId);
    if (!k) {
      const derived = hkdf(master, `form:sign:ed25519:${checkKeyId(keyId)}`);
      k = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, derived]), format: 'der', type: 'pkcs8' });
      keys.set(keyId, k);
    }
    return k;
  };
  return {
    async sign(keyId, data) {
      return { alg: 'ed25519', signature: new Uint8Array(sign(null, data, key(keyId))) };
    },
    async publicKey(keyId) {
      const jwk = createPublicKey(key(keyId)).export({ format: 'jwk' });
      return { alg: 'ed25519', key: new Uint8Array(Buffer.from(jwk.x ?? '', 'base64url')) };
    },
  };
}

/** A P-256 public key (SPKI DER or PEM) as the 65-byte uncompressed SEC1 point the port uses. */
export function p256Point(key: string | Uint8Array): Uint8Array {
  const k = typeof key === 'string' ? createPublicKey(key) : createPublicKey({ key: Buffer.from(key), format: 'der', type: 'spki' });
  const jwk = k.export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new PortError('unsupported', 'the KMS key is not a P-256 key');
  return new Uint8Array(Buffer.concat([Buffer.of(4), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
}

/** An ECDSA P-256 signature in DER (`SEQUENCE { r INTEGER, s INTEGER }`) as 64-byte IEEE P1363 (r ‖ s). */
export function derToP1363(der: Uint8Array): Uint8Array {
  const b = Buffer.from(der);
  const fail = () => new PortError('integrity', 'malformed ECDSA signature from the KMS');
  let i = 0;
  if (b[i++] !== 0x30) throw fail();
  let len = b[i++] ?? 0;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let j = 0; j < n; j++) len = (len << 8) | (b[i++] ?? 0);
  }
  if (i + len !== b.length) throw fail();
  const int = (): Buffer => {
    if (b[i++] !== 0x02) throw fail();
    const l = b[i++] ?? 0;
    let v = b.subarray(i, i + l);
    i += l;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32 || v.length === 0) throw fail();
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);
  };
  const r = int();
  const s = int();
  if (i !== b.length) throw fail();
  return new Uint8Array(Buffer.concat([r, s]));
}
