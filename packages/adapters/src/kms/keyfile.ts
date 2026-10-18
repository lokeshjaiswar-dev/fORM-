import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PortError, type KeyContext, type KeyProvider } from '@form/ports';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_DEK_BYTES = 1024;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const invalid = (message: string) => new PortError('invalid_argument', message);
const derive = (master: Uint8Array, info: string) => Buffer.from(hkdfSync('sha256', master, new Uint8Array(0), info, 32));

function checkOrg(ctx: KeyContext): string {
  if (ctx.orgId.length === 0) throw invalid('orgId is required');
  return `form:dek:v${VERSION}|${ctx.orgId}`;
}

function checkKeyId(keyId: string): string {
  if (!KEY_ID.test(keyId)) throw invalid(`invalid key id ${JSON.stringify(keyId)}`);
  return keyId;
}

/**
 * A master key from a local file (architecture §6: on-prem and air-gapped `KMS_DRIVER=keyfile`; dev).
 * Data keys are wrapped with AES-256-GCM under an HKDF-derived KEK with the org bound as AAD; signing keys
 * are Ed25519, derived per key id. The file must be protected by the platform (k8s Secret with etcd
 * encryption or an external secrets store) and escrowed.
 */
export function createKeyfileKeyProvider(o: { masterKey: Uint8Array }): KeyProvider {
  if (o.masterKey.byteLength !== 32) throw invalid('the master key must be 32 bytes');
  const master = Uint8Array.from(o.masterKey);
  const kek = derive(master, `form:kek:v${VERSION}`);
  const kekRef = `keyfile:${createHash('sha256').update('form:kek-ref').update(master).digest('hex').slice(0, 16)}`;
  const signingKeys = new Map<string, KeyObject>();

  const signingKey = (keyId: string): KeyObject => {
    let k = signingKeys.get(keyId);
    if (!k) {
      const seed = derive(master, `form:sign:ed25519:${checkKeyId(keyId)}`);
      k = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
      signingKeys.set(keyId, k);
    }
    return k;
  };

  return {
    async wrap(plaintextKey, ctx) {
      const aad = checkOrg(ctx);
      if (plaintextKey.byteLength === 0 || plaintextKey.byteLength > MAX_DEK_BYTES) throw invalid(`a data key must be 1..${MAX_DEK_BYTES} bytes`);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', kek, iv);
      cipher.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
      return { wrapped: new Uint8Array(Buffer.concat([Buffer.of(VERSION), iv, cipher.getAuthTag(), ct])), kekRef };
    },

    async unwrap(wrapped, ref, ctx) {
      const aad = checkOrg(ctx);
      if (ref !== kekRef) throw new PortError('not_found', `this keyfile does not hold ${ref}`);
      if (wrapped.byteLength < 1 + IV_BYTES + TAG_BYTES + 1 || wrapped[0] !== VERSION) throw new PortError('integrity', 'malformed wrapped key');
      const b = Buffer.from(wrapped);
      try {
        const decipher = createDecipheriv('aes-256-gcm', kek, b.subarray(1, 1 + IV_BYTES));
        decipher.setAAD(Buffer.from(aad));
        decipher.setAuthTag(b.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES));
        return new Uint8Array(Buffer.concat([decipher.update(b.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]));
      } catch (e) {
        throw new PortError('integrity', 'wrapped key failed authentication', { cause: e });
      }
    },

    async sign(keyId, data) {
      return { alg: 'ed25519', signature: new Uint8Array(sign(null, data, signingKey(keyId))) };
    },

    async publicKey(keyId) {
      const jwk = createPublicKey(signingKey(keyId)).export({ format: 'jwk' });
      return { alg: 'ed25519', key: new Uint8Array(Buffer.from(jwk.x ?? '', 'base64url')) };
    },
  };
}

/** Reads a keyfile holding 32 raw bytes or their base64 (whitespace ignored). */
export async function loadKeyfileKeyProvider(filePath: string): Promise<KeyProvider> {
  const raw = await readFile(filePath);
  if (raw.byteLength === 32) return createKeyfileKeyProvider({ masterKey: raw });
  const text = raw.toString('utf8').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) throw invalid('a keyfile holds 32 raw bytes or their base64');
  return createKeyfileKeyProvider({ masterKey: Buffer.from(text, 'base64') });
}

/** A fresh master key as base64, for `pnpm dev:setup` and tests. */
export function generateKeyfileContent(): string {
  return `${randomBytes(32).toString('base64')}\n`;
}
