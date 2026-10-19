import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DEV_KEY_ID, type PackSigner, type SignatureAlg, type TrustedKey } from '../src/index.ts';

/* Pack signers for `templates:build`. The key decides the algorithm (templates spec §8.1): Ed25519 by default, ES256 for a P-256 key. */

/** DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The P0 development key: a published seed, so anyone can sign with it. Only development readers trust it. */
const DEV_SEED = createHash('sha256').update('fORM- development pack signing key; never trust it outside development').digest();

function algOf(key: KeyObject): SignatureAlg {
  if (key.asymmetricKeyType === 'ed25519') return 'ed25519';
  if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') return 'es256';
  throw new Error(`pack keys are Ed25519 or P-256, not ${key.asymmetricKeyType ?? 'unknown'}`);
}

/** A signer for one private key; ES256 signatures use the IEEE P1363 (r ‖ s) form the port specifies. */
export function keySigner(keyId: string, privateKey: KeyObject): PackSigner {
  const alg = algOf(privateKey);
  return {
    keyId,
    async sign(data) {
      const signature = alg === 'ed25519' ? sign(null, data, privateKey) : sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
      return { alg, signature: new Uint8Array(signature) };
    },
  };
}

/** The key a reader needs to trust `keySigner(keyId, privateKey)`. */
export function trustedKeyOf(keyId: string, privateKey: KeyObject): TrustedKey {
  const alg = algOf(privateKey);
  const publicKey = createPublicKey(privateKey);
  const raw = alg === 'ed25519'
    ? Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url')
    : publicKey.export({ format: 'der', type: 'spki' }).subarray(-65);
  return { keyId, alg, publicKey: raw.toString('base64') };
}

export const devPrivateKey = (): KeyObject => createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, DEV_SEED]), format: 'der', type: 'pkcs8' });

export const devSigner = (): PackSigner => keySigner(DEV_KEY_ID, devPrivateKey());

/**
 * `FORM_PACK_SIGNING_KEY` (a PKCS#8 PEM file) and `FORM_PACK_KEY_ID` select a release key; without them the
 * development key signs.
 */
export function signerFromEnv(env: NodeJS.ProcessEnv = process.env): PackSigner {
  const file = env['FORM_PACK_SIGNING_KEY'];
  if (!file) return devSigner();
  const keyId = env['FORM_PACK_KEY_ID'];
  if (!keyId) throw new Error('FORM_PACK_KEY_ID is required with FORM_PACK_SIGNING_KEY');
  return keySigner(keyId, createPrivateKey(readFileSync(file)));
}
