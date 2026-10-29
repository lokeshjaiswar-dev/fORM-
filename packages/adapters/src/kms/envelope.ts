import { randomBytes } from 'node:crypto';
import { PortError, type KeyProvider } from '@form/ports';
import { createAppSigner, dekContext, invalid, type Signer } from './signing.ts';

/**
 * The KMS root key of architecture §2.6 (one per region on SaaS; a Vault transit key on-prem). It encrypts small
 * payloads (org KEKs, the signing seed) with `aad` authenticated alongside, and never hands its key material out.
 */
export interface RootKey {
  /** `aws`, `gcp`, `azure` or `vault`: the first part of every `kekRef` it issues. */
  readonly provider: string;
  encrypt(plaintext: Uint8Array, aad: string): Promise<{ ciphertext: Uint8Array; keyRef: string }>;
  /**
   * `keyRef` as `encrypt` returned it. A ref this root does not hold → PortError('not_found'); a ciphertext or `aad`
   * that does not authenticate → PortError('integrity'); the KMS unreachable or refusing us → PortError('unavailable').
   */
  decrypt(ciphertext: Uint8Array, keyRef: string, aad: string): Promise<Uint8Array>;
}

const VERSION = 1;
const MAX_DEK_BYTES = 1024;
const SEED_AAD = 'form:signing-seed:v1';

/**
 * A KeyProvider over a KMS root key: data keys go to the KMS with the org as authenticated context (one call per
 * wrap and unwrap; WP-1.11 caches the unwrapped org KEK), and `signer` signs. `kekRef` is `<provider>:<key ref>`.
 */
export function createKmsKeyProvider(o: { root: RootKey; signer: Signer }): KeyProvider {
  const prefix = `${o.root.provider}:`;
  return {
    async wrap(plaintextKey, ctx) {
      const aad = dekContext(ctx.orgId);
      if (plaintextKey.byteLength === 0 || plaintextKey.byteLength > MAX_DEK_BYTES) throw invalid(`a data key must be 1..${MAX_DEK_BYTES} bytes`);
      const { ciphertext, keyRef } = await o.root.encrypt(plaintextKey, aad);
      return { wrapped: new Uint8Array(Buffer.concat([Buffer.of(VERSION), ciphertext])), kekRef: `${prefix}${keyRef}` };
    },

    async unwrap(wrapped, kekRef, ctx) {
      const aad = dekContext(ctx.orgId);
      if (!kekRef.startsWith(prefix)) throw new PortError('not_found', `this ${o.root.provider} key provider does not hold ${kekRef}`);
      if (wrapped.byteLength < 2 || wrapped[0] !== VERSION) throw new PortError('integrity', 'malformed wrapped key');
      return o.root.decrypt(wrapped.subarray(1), kekRef.slice(prefix.length), aad);
    },

    sign: (keyId, data) => o.signer.sign(keyId, data),
    publicKey: (keyId) => o.signer.publicKey(keyId),
  };
}

/** What `KMS_SIGNING_SEED_FILE` holds: the app-held signing seed, encrypted by the root key. */
interface SealedSeed {
  v: 1;
  provider: string;
  keyRef: string;
  ciphertext: string;
}

/**
 * A fresh signing seed sealed by the root key, as the text of `KMS_SIGNING_SEED_FILE` (`form-admin keys init`, the
 * nightly KMS job). Keep the file with the other secrets; losing it means new signing keys, not lost data.
 */
export async function sealSigningSeed(root: RootKey, seed: Uint8Array = randomBytes(32)): Promise<string> {
  if (seed.byteLength !== 32) throw invalid('a signing seed is 32 bytes');
  const { ciphertext, keyRef } = await root.encrypt(seed, SEED_AAD);
  const sealed: SealedSeed = { v: 1, provider: root.provider, keyRef, ciphertext: Buffer.from(ciphertext).toString('base64url') };
  return `${JSON.stringify(sealed)}\n`;
}

/** The app-held Ed25519 signer of a sealed seed; the KMS is asked once, at boot. */
export async function openSealedSigner(root: RootKey, sealedText: string): Promise<Signer> {
  let s: Partial<SealedSeed>;
  try {
    s = JSON.parse(sealedText) as Partial<SealedSeed>;
  } catch {
    throw invalid('the signing seed file is not JSON');
  }
  if (s.v !== 1 || typeof s.keyRef !== 'string' || typeof s.ciphertext !== 'string') throw invalid('the signing seed file is malformed');
  if (s.provider !== root.provider) throw invalid(`the signing seed was sealed by ${String(s.provider)}, not ${root.provider}`);
  return createAppSigner(await root.decrypt(Buffer.from(s.ciphertext, 'base64url'), s.keyRef, SEED_AAD));
}
