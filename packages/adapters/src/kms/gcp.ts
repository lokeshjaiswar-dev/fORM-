import { createHash } from 'node:crypto';
import { PortError } from '@form/ports';
import type { RootKey } from './envelope.ts';
import { restJson, str, type RestOptions, type RestReply, type TokenSource } from './rest.ts';
import { checkKeyId, derToP1363, p256Point, type Signer } from './signing.ts';

export interface GcpKmsOptions extends RestOptions {
  /** `projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>` (`KMS_KEY_ID`). */
  keyName: string;
  tokens: TokenSource;
  /** Default `https://cloudkms.googleapis.com`; a Private Service Connect endpoint or the test emulator. */
  endpoint?: string | undefined;
}

const CRYPTO_KEY = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/;
const KEY_VERSION = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[^/]+$/;
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

function caller(o: RestOptions & { tokens: TokenSource; endpoint?: string | undefined }) {
  const base = (o.endpoint ?? 'https://cloudkms.googleapis.com').replace(/\/+$/, '');
  return async (method: 'GET' | 'POST', path: string, json?: unknown): Promise<RestReply> => {
    for (let attempt = 0; ; attempt++) {
      const reply = await restJson(o, new URL(`${base}/v1/${path}`), {
        method,
        headers: { authorization: `Bearer ${await o.tokens.token()}` },
        ...(json !== undefined ? { json } : {}),
      });
      if (reply.status === 401 && attempt === 0) {
        o.tokens.invalidate();
        continue;
      }
      return reply;
    }
  };
}

function failure(reply: RestReply, what: string, integrityOn400: boolean): PortError {
  const err = reply.body.error as { message?: unknown } | undefined;
  const message = `GCP KMS ${what}: ${reply.status} ${str(err?.message) ?? ''}`.trim();
  if (reply.status === 400 && integrityOn400) return new PortError('integrity', message);
  if (reply.status === 404) return new PortError('not_found', message);
  return new PortError('unavailable', message);
}

/** A Cloud KMS symmetric key as the root key; the AAD is Cloud KMS's additional authenticated data. */
export function createGcpRootKey(o: GcpKmsOptions): RootKey {
  if (!CRYPTO_KEY.test(o.keyName)) throw new PortError('invalid_argument', `expected projects/…/cryptoKeys/<key>, got ${JSON.stringify(o.keyName)}`);
  const call = caller(o);
  return {
    provider: 'gcp',
    async encrypt(plaintext, aad) {
      const reply = await call('POST', `${o.keyName}:encrypt`, { plaintext: b64(plaintext), additionalAuthenticatedData: b64(Buffer.from(aad)) });
      const ct = str(reply.body.ciphertext);
      if (reply.status !== 200 || !ct) throw failure(reply, 'encrypt', false);
      return { ciphertext: new Uint8Array(Buffer.from(ct, 'base64')), keyRef: o.keyName };
    },
    async decrypt(ciphertext, keyRef, aad) {
      if (!CRYPTO_KEY.test(keyRef)) throw new PortError('not_found', `not a Cloud KMS key: ${keyRef}`);
      const reply = await call('POST', `${keyRef}:decrypt`, { ciphertext: b64(ciphertext), additionalAuthenticatedData: b64(Buffer.from(aad)) });
      const pt = str(reply.body.plaintext);
      if (reply.status !== 200 || !pt) throw failure(reply, 'decrypt', true);
      return new Uint8Array(Buffer.from(pt, 'base64'));
    },
  };
}

/** ES256 with Cloud KMS `EC_SIGN_P256_SHA256` key versions; `keys` maps app key ids to `…/cryptoKeyVersions/<n>`. */
export function createGcpNativeSigner(o: RestOptions & { tokens: TokenSource; endpoint?: string | undefined; keys: Readonly<Record<string, string>> }): Signer {
  const call = caller(o);
  const publicKeys = new Map<string, Uint8Array>();
  const version = (keyId: string) => {
    const v = o.keys[checkKeyId(keyId)];
    if (!v) throw new PortError('not_found', `no KMS-native signing key is mapped for ${keyId}`);
    if (!KEY_VERSION.test(v)) throw new PortError('invalid_argument', `expected a cryptoKeyVersions name for ${keyId}`);
    return v;
  };
  return {
    async sign(keyId, data) {
      const v = version(keyId);
      const reply = await call('POST', `${v}:asymmetricSign`, { digest: { sha256: createHash('sha256').update(data).digest('base64') } });
      const sig = str(reply.body.signature);
      if (reply.status !== 200 || !sig) throw failure(reply, 'asymmetricSign', false);
      return { alg: 'es256', signature: derToP1363(Buffer.from(sig, 'base64')) };
    },
    async publicKey(keyId) {
      const v = version(keyId);
      let key = publicKeys.get(keyId);
      if (!key) {
        const reply = await call('GET', `${v}/publicKey`);
        const pem = str(reply.body.pem);
        if (reply.status !== 200 || !pem) throw failure(reply, 'getPublicKey', false);
        if (reply.body.algorithm !== 'EC_SIGN_P256_SHA256') throw new PortError('unsupported', `${v} is ${String(reply.body.algorithm)}, not EC_SIGN_P256_SHA256`);
        key = p256Point(pem);
        publicKeys.set(keyId, key);
      }
      return { alg: 'es256', key };
    },
  };
}
