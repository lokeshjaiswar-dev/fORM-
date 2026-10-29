import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PortError, type KeyProvider } from '@form/ports';
import { createAppSigner, dekContext, hkdf, invalid } from './signing.ts';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_DEK_BYTES = 1024;

/**
 * A master key from a local file (architecture §6: on-prem and air-gapped `KMS_DRIVER=keyfile`; dev).
 * Data keys are wrapped with AES-256-GCM under an HKDF-derived KEK with the org bound as AAD; signing keys
 * are Ed25519, derived per key id. The file must be protected by the platform (k8s Secret with etcd
 * encryption or an external secrets store) and escrowed.
 */
export function createKeyfileKeyProvider(o: { masterKey: Uint8Array }): KeyProvider {
  if (o.masterKey.byteLength !== 32) throw invalid('the master key must be 32 bytes');
  const master = Uint8Array.from(o.masterKey);
  const kek = hkdf(master, `form:kek:v${VERSION}`);
  const kekRef = `keyfile:${createHash('sha256').update('form:kek-ref').update(master).digest('hex').slice(0, 16)}`;
  const signer = createAppSigner(master);

  return {
    async wrap(plaintextKey, ctx) {
      const aad = dekContext(ctx.orgId);
      if (plaintextKey.byteLength === 0 || plaintextKey.byteLength > MAX_DEK_BYTES) throw invalid(`a data key must be 1..${MAX_DEK_BYTES} bytes`);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', kek, iv);
      cipher.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
      return { wrapped: new Uint8Array(Buffer.concat([Buffer.of(VERSION), iv, cipher.getAuthTag(), ct])), kekRef };
    },

    async unwrap(wrapped, ref, ctx) {
      const aad = dekContext(ctx.orgId);
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

    sign: (keyId, data) => signer.sign(keyId, data),
    publicKey: (keyId) => signer.publicKey(keyId),
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
