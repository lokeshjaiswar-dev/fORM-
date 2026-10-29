import { PortError } from '@form/ports';
import type { RootKey } from './envelope.ts';
import { restJson, str, type RestOptions, type RestReply, type TokenSource } from './rest.ts';
import { checkKeyId, p256Point, type Signer } from './signing.ts';

const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export interface VaultOptions extends RestOptions {
  /** `VAULT_ADDR`, e.g. `https://vault.corp.local:8200`. */
  address: string;
  /** The transit mount; default `transit`. */
  mount?: string;
  /** Vault tokens: `vaultStaticToken` or `vaultKubernetesTokens`. */
  tokens: TokenSource;
  /** Vault Enterprise namespace. */
  namespace?: string | undefined;
}

function checkName(kind: string, v: string): string {
  if (!NAME.test(v)) throw new PortError('invalid_argument', `invalid Vault ${kind} ${JSON.stringify(v)}`);
  return v;
}

function caller(o: VaultOptions) {
  const base = o.address.replace(/\/+$/, '');
  return async (method: 'GET' | 'POST', path: string, json?: unknown): Promise<RestReply> => {
    for (let attempt = 0; ; attempt++) {
      const reply = await restJson(o, new URL(`${base}/v1/${path}`), {
        method,
        headers: { 'x-vault-token': await o.tokens.token(), ...(o.namespace ? { 'x-vault-namespace': o.namespace } : {}) },
        ...(json !== undefined ? { json } : {}),
      });
      // An expired login token answers 403; a fresh login gets one more try.
      if (reply.status === 403 && attempt === 0) {
        o.tokens.invalidate();
        continue;
      }
      return reply;
    }
  };
}

function failure(reply: RestReply, what: string, integrityOn400: boolean): PortError {
  const errors = Array.isArray(reply.body.errors) ? reply.body.errors.filter((e): e is string => typeof e === 'string') : [];
  const message = `Vault transit ${what}: ${reply.status} ${errors.join('; ')}`.trim();
  if (reply.status === 400 && integrityOn400) return new PortError('integrity', message);
  if (reply.status === 404) return new PortError('not_found', message);
  return new PortError('unavailable', message);
}

const data = (reply: RestReply) => (reply.body.data ?? {}) as Record<string, unknown>;
const b64 = (b: Uint8Array | string) => Buffer.from(b).toString('base64');

/**
 * A Vault transit key (`aes256-gcm96`) as the root key (on-prem). The AAD is transit's `associated_data`; the
 * ciphertext is transit's `vault:v<n>:…` text, which carries the key version, so rotated keys keep decrypting.
 */
export function createVaultRootKey(o: VaultOptions & { key: string }): RootKey {
  const mount = checkName('mount', o.mount ?? 'transit');
  const key = checkName('key', o.key);
  const ref = `${mount}/${key}`;
  const call = caller(o);
  return {
    provider: 'vault',
    async encrypt(plaintext, aad) {
      const reply = await call('POST', `${mount}/encrypt/${key}`, { plaintext: b64(plaintext), associated_data: b64(aad) });
      const ct = str(data(reply).ciphertext);
      if (reply.status !== 200 || !ct) throw failure(reply, 'encrypt', false);
      return { ciphertext: new Uint8Array(Buffer.from(ct, 'utf8')), keyRef: ref };
    },
    async decrypt(ciphertext, keyRef, aad) {
      if (keyRef !== ref) throw new PortError('not_found', `this Vault key provider does not hold ${keyRef}`);
      const text = Buffer.from(ciphertext).toString('utf8');
      if (!/^vault:v\d+:[A-Za-z0-9+/=]+$/.test(text)) throw new PortError('integrity', 'malformed Vault ciphertext');
      const reply = await call('POST', `${mount}/decrypt/${key}`, { ciphertext: text, associated_data: b64(aad) });
      const pt = data(reply).plaintext;
      if (reply.status !== 200 || typeof pt !== 'string') throw failure(reply, 'decrypt', true);
      return new Uint8Array(Buffer.from(pt, 'base64'));
    },
  };
}

/** ES256 with transit `ecdsa-p256` keys (JWS marshaling gives r ‖ s); `keys` maps app key ids to transit key names. */
export function createVaultNativeSigner(o: VaultOptions & { keys: Readonly<Record<string, string>> }): Signer {
  const mount = checkName('mount', o.mount ?? 'transit');
  const call = caller(o);
  const publicKeys = new Map<string, Uint8Array>();
  const keyName = (keyId: string) => {
    const k = o.keys[checkKeyId(keyId)];
    if (!k) throw new PortError('not_found', `no KMS-native signing key is mapped for ${keyId}`);
    return checkName('key', k);
  };
  return {
    async sign(keyId, input) {
      const reply = await call('POST', `${mount}/sign/${keyName(keyId)}`, { input: b64(input), hash_algorithm: 'sha2-256', marshaling_algorithm: 'jws' });
      const sig = str(data(reply).signature);
      if (reply.status !== 200 || !sig) throw failure(reply, 'sign', false);
      const raw = Buffer.from(sig.slice(sig.lastIndexOf(':') + 1), 'base64url');
      if (raw.length !== 64) throw new PortError('integrity', 'Vault returned a malformed ES256 signature');
      return { alg: 'es256', signature: new Uint8Array(raw) };
    },
    async publicKey(keyId) {
      const name = keyName(keyId);
      let point = publicKeys.get(keyId);
      if (!point) {
        const reply = await call('GET', `${mount}/keys/${name}`);
        const d = data(reply);
        if (reply.status !== 200) throw failure(reply, 'read key', false);
        if (d.type !== 'ecdsa-p256') throw new PortError('unsupported', `transit key ${name} is ${String(d.type)}, not ecdsa-p256`);
        const versions = (d.keys ?? {}) as Record<string, { public_key?: unknown }>;
        const pem = str(versions[String(d.latest_version)]?.public_key);
        if (!pem) throw new PortError('unavailable', `transit key ${name} has no public key`);
        point = p256Point(pem);
        publicKeys.set(keyId, point);
      }
      return { alg: 'es256', key: point };
    },
  };
}

/** A fixed token (`KMS_VAULT_TOKEN_FILE`); renewal is the operator's (a periodic token or Vault Agent). */
export function vaultStaticToken(token: string): TokenSource {
  if (token.trim().length === 0) throw new PortError('invalid_argument', 'the Vault token is empty');
  return { token: async () => token.trim(), invalidate: () => {} };
}

/** Kubernetes auth: logs in with the pod's service-account JWT, again when the token expires or is refused. */
export function vaultKubernetesTokens(
  o: RestOptions & { address: string; role: string; jwt: () => Promise<string>; authMount?: string; namespace?: string | undefined; now?: () => number },
): TokenSource {
  const now = o.now ?? Date.now;
  const mount = checkName('auth mount', o.authMount ?? 'kubernetes');
  let cached: { token: string; until: number } | undefined;
  return {
    async token() {
      if (cached && cached.until > now()) return cached.token;
      const reply = await restJson(o, new URL(`${o.address.replace(/\/+$/, '')}/v1/auth/${mount}/login`), {
        method: 'POST',
        headers: o.namespace ? { 'x-vault-namespace': o.namespace } : {},
        json: { role: o.role, jwt: (await o.jwt()).trim() },
      });
      const auth = (reply.body.auth ?? {}) as { client_token?: unknown; lease_duration?: unknown };
      const token = str(auth.client_token);
      if (reply.status !== 200 || !token) throw new PortError('unavailable', `Vault kubernetes login failed (${reply.status})`);
      const lease = Number(auth.lease_duration);
      cached = { token, until: now() + Math.max(0, (Number.isFinite(lease) && lease > 0 ? lease : 300) - 30) * 1000 };
      return token;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
