import { createHash, timingSafeEqual } from 'node:crypto';
import { PortError } from '@form/ports';
import type { RootKey } from './envelope.ts';
import { restJson, str, type RestOptions, type RestReply, type TokenSource } from './rest.ts';
import { checkKeyId, type Signer } from './signing.ts';

const API_VERSION = '7.4';
const KEY_URL = /^(https?:\/\/[^/]+)\/keys\/([A-Za-z0-9-]{1,127})(?:\/([0-9a-f]{32}))?\/?$/;

export interface AzureKeyVaultOptions extends RestOptions {
  /** `https://<vault>.vault.azure.net/keys/<name>` of an RSA key (`KMS_KEY_ID`); a version pins it. */
  keyUrl: string;
  tokens: TokenSource;
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const digest = (s: string | Uint8Array) => createHash('sha256').update(s).digest();

function parseKeyUrl(url: string): { base: string; name: string; version?: string } {
  const m = KEY_URL.exec(url);
  if (!m) throw new PortError('invalid_argument', `expected https://<vault>.vault.azure.net/keys/<name>, got ${JSON.stringify(url)}`);
  return { base: m[1]!, name: m[2]!, ...(m[3] ? { version: m[3] } : {}) };
}

function caller(o: RestOptions & { tokens: TokenSource }) {
  return async (method: 'GET' | 'POST', url: string, json?: unknown): Promise<RestReply> => {
    for (let attempt = 0; ; attempt++) {
      const reply = await restJson(o, new URL(`${url}?api-version=${API_VERSION}`), {
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
  const err = reply.body.error as { code?: unknown; message?: unknown } | undefined;
  const message = `Azure Key Vault ${what}: ${reply.status} ${str(err?.code) ?? ''} ${str(err?.message) ?? ''}`.trim();
  if (reply.status === 400 && integrityOn400) return new PortError('integrity', message);
  if (reply.status === 404) return new PortError('not_found', message);
  return new PortError('unavailable', message);
}

/**
 * An Azure Key Vault RSA key as the root key (`RSA-OAEP-256` wrapkey/unwrapkey). Key Vault has no AAD for key wrap,
 * so the wrapped payload is `key ‖ SHA-256(aad)`: OAEP is non-malleable, and an unwrap under another org fails the
 * suffix check with PortError('integrity'). `keyRef` is the versioned key id Key Vault answered, so rotated keys still unwrap.
 */
export function createAzureRootKey(o: AzureKeyVaultOptions): RootKey {
  const key = parseKeyUrl(o.keyUrl);
  const keyUrl = `${key.base}/keys/${key.name}${key.version ? `/${key.version}` : ''}`;
  const call = caller(o);
  return {
    provider: 'azure',
    async encrypt(plaintext, aad) {
      const reply = await call('POST', `${keyUrl}/wrapkey`, { alg: 'RSA-OAEP-256', value: b64url(Buffer.concat([plaintext, digest(aad)])) });
      const kid = str(reply.body.kid);
      const value = str(reply.body.value);
      if (reply.status !== 200 || !kid || !value) throw failure(reply, 'wrapkey', false);
      return { ciphertext: new Uint8Array(Buffer.from(value, 'base64url')), keyRef: kid };
    },
    async decrypt(ciphertext, keyRef, aad) {
      const ref = KEY_URL.exec(keyRef);
      if (!ref || ref[1] !== key.base || ref[2] !== key.name || !ref[3]) throw new PortError('not_found', `this Key Vault key does not hold ${keyRef}`);
      const reply = await call('POST', `${keyRef}/unwrapkey`, { alg: 'RSA-OAEP-256', value: b64url(ciphertext) });
      const value = str(reply.body.value);
      if (reply.status !== 200 || !value) throw failure(reply, 'unwrapkey', true);
      const payload = Buffer.from(value, 'base64url');
      const expected = digest(aad);
      if (payload.length <= expected.length || !timingSafeEqual(payload.subarray(payload.length - expected.length), expected)) {
        throw new PortError('integrity', 'the wrapped key is bound to another context');
      }
      return new Uint8Array(payload.subarray(0, payload.length - expected.length));
    },
  };
}

/** ES256 with Key Vault EC P-256 keys (architecture §2.7: the KMS-native option); `keys` maps app key ids to key URLs. */
export function createAzureNativeSigner(o: RestOptions & { tokens: TokenSource; keys: Readonly<Record<string, string>> }): Signer {
  const call = caller(o);
  const publicKeys = new Map<string, Uint8Array>();
  const keyUrl = (keyId: string) => {
    const url = o.keys[checkKeyId(keyId)];
    if (!url) throw new PortError('not_found', `no KMS-native signing key is mapped for ${keyId}`);
    const k = parseKeyUrl(url);
    return `${k.base}/keys/${k.name}${k.version ? `/${k.version}` : ''}`;
  };
  return {
    async sign(keyId, data) {
      const url = keyUrl(keyId);
      const reply = await call('POST', `${url}/sign`, { alg: 'ES256', value: b64url(digest(data)) });
      const value = str(reply.body.value);
      if (reply.status !== 200 || !value) throw failure(reply, 'sign', false);
      const signature = Buffer.from(value, 'base64url');
      if (signature.length !== 64) throw new PortError('integrity', 'Key Vault returned a malformed ES256 signature');
      return { alg: 'es256', signature: new Uint8Array(signature) };
    },
    async publicKey(keyId) {
      const url = keyUrl(keyId);
      let point = publicKeys.get(keyId);
      if (!point) {
        const reply = await call('GET', url);
        const jwk = reply.body.key as { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown } | undefined;
        if (reply.status !== 200 || !jwk) throw failure(reply, 'get key', false);
        const x = str(jwk.x);
        const y = str(jwk.y);
        if ((jwk.kty !== 'EC' && jwk.kty !== 'EC-HSM') || jwk.crv !== 'P-256' || !x || !y) throw new PortError('unsupported', `${url} is not an EC P-256 key`);
        point = new Uint8Array(Buffer.concat([Buffer.of(4), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]));
        publicKeys.set(keyId, point);
      }
      return { alg: 'es256', key: point };
    },
  };
}
