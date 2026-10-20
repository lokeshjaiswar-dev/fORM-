import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  createVerify,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { p1363ToDer, signP256Digest } from './ecdsa-p256.ts';

/**
 * In-process emulators of the AWS KMS, Cloud KMS and Azure Key Vault APIs the KMS drivers call, with real
 * cryptography, so the drivers' encodings, context binding and error mapping are exercised without a cloud account.
 * The nightly job (`.github/workflows/cloud-kms-nightly.yml`) runs the same contract against the real services.
 */
export interface KmsEmulator {
  /** Base URL to point the driver at. */
  url: string;
  /** Requests served, so a test can prove a denied call never left the process. */
  readonly requests: number;
  close(): Promise<void>;
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> };
type Handler = (req: IncomingMessage, body: Buffer, url: URL) => Reply | Promise<Reply>;

async function serve(handler: Handler): Promise<{ url: string; count: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      count += 1;
      Promise.resolve()
        .then(() => handler(req, Buffer.concat(parts), new URL(req.url ?? '/', 'http://emulator')))
        .catch((e: unknown): Reply => ({ status: 500, body: { message: String(e) } }))
        .then((r) => {
          res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
          res.end(JSON.stringify(r.body));
        });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    count: () => count,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const json = (b: Buffer): Record<string, unknown> => {
  try {
    const v = JSON.parse(b.toString('utf8')) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** AES-256-GCM sealing with `aad`: version ‖ iv ‖ tag ‖ ct, the shape of a KMS ciphertext blob. */
function seal(key: Buffer, plaintext: Buffer, aad: Buffer, prefix = Buffer.alloc(0)): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([prefix, iv, c.getAuthTag(), ct]);
}

function open(key: Buffer, blob: Buffer, aad: Buffer, prefixLength = 0): Buffer | null {
  if (blob.length < prefixLength + 28) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, blob.subarray(prefixLength, prefixLength + 12));
    d.setAAD(aad);
    d.setAuthTag(blob.subarray(prefixLength + 12, prefixLength + 28));
    return Buffer.concat([d.update(blob.subarray(prefixLength + 28)), d.final()]);
  } catch {
    return null;
  }
}

const ecKey = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
const spki = (k: KeyObject) => createPublicKey(k).export({ format: 'der', type: 'spki' });

export interface AwsKmsEmulator extends KmsEmulator {
  region: string;
  /** The alias of the symmetric root key. */
  keyId: string;
  keyArn: string;
  /** ARNs of ECC_NIST_P256 signing keys, one per name, created on first use. */
  signingKey(name: string): string;
}

/** AWS KMS JSON 1.1 (`X-Amz-Target: TrentService.*`): Encrypt, Decrypt, Sign, GetPublicKey. Requests must carry SigV4. */
export async function startAwsKmsEmulator(): Promise<AwsKmsEmulator> {
  const region = 'ap-south-1';
  const arn = (id: string) => `arn:aws:kms:${region}:111122223333:key/${id}`;
  const root = { arn: arn(randomUUID()), key: randomBytes(32) };
  const alias = 'alias/form-root';
  const signers = new Map<string, { arn: string; key: KeyObject }>();
  const byArn = (id: string) => [...signers.values()].find((s) => s.arn === id);
  const error = (type: string, message: string, status = 400): Reply => ({ status, body: { __type: type, message }, headers: { 'x-amzn-errortype': type } });
  const context = (v: unknown) =>
    Buffer.from(JSON.stringify(Object.entries((v ?? {}) as Record<string, string>).sort(([a], [b]) => (a < b ? -1 : 1))));

  const s = await serve((req, raw) => {
    if (!String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 ')) return error('MissingAuthenticationTokenException', 'missing SigV4');
    const target = String(req.headers['x-amz-target'] ?? '');
    const b = json(raw);
    switch (target) {
      case 'TrentService.Encrypt': {
        if (b.KeyId !== alias && b.KeyId !== root.arn) return error('NotFoundException', `key ${String(b.KeyId)} does not exist`);
        const blob = seal(root.key, Buffer.from(String(b.Plaintext), 'base64'), context(b.EncryptionContext), Buffer.of(1));
        return { status: 200, body: { CiphertextBlob: blob.toString('base64'), KeyId: root.arn, EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' } };
      }
      case 'TrentService.Decrypt': {
        if (b.KeyId !== undefined && b.KeyId !== root.arn && b.KeyId !== alias) return error('IncorrectKeyException', 'the ciphertext was not encrypted under this key');
        const pt = open(root.key, Buffer.from(String(b.CiphertextBlob), 'base64'), context(b.EncryptionContext), 1);
        if (!pt) return error('InvalidCiphertextException', 'invalid ciphertext');
        return { status: 200, body: { Plaintext: pt.toString('base64'), KeyId: root.arn } };
      }
      case 'TrentService.Sign': {
        const k = byArn(String(b.KeyId));
        if (!k) return error('NotFoundException', `key ${String(b.KeyId)} does not exist`);
        if (b.SigningAlgorithm !== 'ECDSA_SHA_256' || b.MessageType !== 'RAW') return error('ValidationException', 'unsupported signing request');
        return { status: 200, body: { KeyId: k.arn, Signature: sign('sha256', Buffer.from(String(b.Message), 'base64'), k.key).toString('base64'), SigningAlgorithm: 'ECDSA_SHA_256' } };
      }
      case 'TrentService.GetPublicKey': {
        const k = byArn(String(b.KeyId));
        if (!k) return error('NotFoundException', `key ${String(b.KeyId)} does not exist`);
        return { status: 200, body: { KeyId: k.arn, PublicKey: spki(k.key).toString('base64'), KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY', SigningAlgorithms: ['ECDSA_SHA_256'] } };
      }
      default:
        return error('UnknownOperationException', target);
    }
  });
  return {
    url: s.url,
    region,
    keyId: alias,
    keyArn: root.arn,
    get requests() {
      return s.count();
    },
    signingKey(name) {
      let k = signers.get(name);
      if (!k) signers.set(name, (k = { arn: arn(randomUUID()), key: ecKey() }));
      return k.arn;
    },
    close: s.close,
  };
}

export interface GcpKmsEmulator extends KmsEmulator {
  keyName: string;
  /** A service-account key file whose token_uri is the emulator. */
  credentials: string;
  /** Version names of EC_SIGN_P256_SHA256 keys, one per name. */
  signingKey(name: string): string;
  /** Expires every token handed out, so the next call answers 401. */
  revokeTokens(): void;
}

/** Cloud KMS REST v1 (encrypt, decrypt, asymmetricSign, publicKey) behind a JWT-bearer token endpoint. */
export async function startGcpKmsEmulator(): Promise<GcpKmsEmulator> {
  const keyName = 'projects/form-test/locations/asia-south1/keyRings/form/cryptoKeys/root';
  const root = randomBytes(32);
  const sa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const tokens = new Set<string>();
  const signers = new Map<string, { version: string; key: KeyObject }>();
  const fail = (status: number, message: string): Reply => ({ status, body: { error: { code: status, message, status: status === 400 ? 'INVALID_ARGUMENT' : 'NOT_FOUND' } } });
  let base = '';

  const s = await serve((req, raw, url) => {
    if (url.pathname === '/token') {
      const form = new URLSearchParams(raw.toString('utf8'));
      const [h = '', c = '', sig = ''] = (form.get('assertion') ?? '').split('.');
      const claims = json(Buffer.from(c, 'base64url'));
      const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(sa.publicKey, Buffer.from(sig, 'base64url'));
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !ok || claims.aud !== `${base}/token`) return { status: 400, body: { error: 'invalid_grant' } };
      const token = randomBytes(16).toString('hex');
      tokens.add(token);
      return { status: 200, body: { access_token: token, expires_in: 3600, token_type: 'Bearer' } };
    }
    if (!tokens.has(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))) return { status: 401, body: { error: { code: 401, message: 'unauthenticated' } } };
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\//, ''));
    const b = json(raw);
    const aad = Buffer.from(String(b.additionalAuthenticatedData ?? ''), 'base64');
    if (path === `${keyName}:encrypt`) {
      return { status: 200, body: { name: `${keyName}/cryptoKeyVersions/1`, ciphertext: seal(root, Buffer.from(String(b.plaintext), 'base64'), aad).toString('base64') } };
    }
    if (path === `${keyName}:decrypt`) {
      const pt = open(root, Buffer.from(String(b.ciphertext), 'base64'), aad);
      return pt ? { status: 200, body: { plaintext: pt.toString('base64') } } : fail(400, 'Decryption failed: the ciphertext is invalid.');
    }
    const signer = [...signers.values()].find((k) => path === `${k.version}:asymmetricSign` || path === `${k.version}/publicKey`);
    if (!signer) return fail(404, `${path} not found`);
    if (path.endsWith('/publicKey')) {
      return { status: 200, body: { pem: createPublicKey(signer.key).export({ format: 'pem', type: 'spki' }), algorithm: 'EC_SIGN_P256_SHA256', name: signer.version } };
    }
    const digest = Buffer.from(String((b.digest as { sha256?: unknown } | undefined)?.sha256 ?? ''), 'base64');
    if (digest.length !== 32) return fail(400, 'digest.sha256 must be 32 bytes');
    return { status: 200, body: { signature: Buffer.from(p1363ToDer(signP256Digest(signer.key, digest))).toString('base64'), name: signer.version } };
  });
  base = s.url;
  return {
    url: s.url,
    keyName,
    credentials: JSON.stringify({
      type: 'service_account',
      client_email: 'form-kms@form-test.iam.gserviceaccount.com',
      private_key: sa.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      token_uri: `${s.url}/token`,
    }),
    get requests() {
      return s.count();
    },
    signingKey(name) {
      let k = signers.get(name);
      if (!k) signers.set(name, (k = { version: `projects/form-test/locations/asia-south1/keyRings/form/cryptoKeys/${name}/cryptoKeyVersions/1`, key: ecKey() }));
      return k.version;
    },
    revokeTokens: () => tokens.clear(),
    close: s.close,
  };
}

export interface AzureKeyVaultEmulator extends KmsEmulator {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** `<url>/keys/form-root`: an RSA key. */
  keyUrl: string;
  /** URLs of EC P-256 keys, one per name. */
  signingKey(name: string): string;
}

/** Key Vault 7.4 (wrapkey, unwrapkey, sign, get key) behind an Entra client-credentials token endpoint. */
export async function startAzureKeyVaultEmulator(): Promise<AzureKeyVaultEmulator> {
  const tenantId = randomUUID();
  const clientId = randomUUID();
  const clientSecret = randomBytes(16).toString('hex');
  const rsa = { name: 'form-root', version: randomBytes(16).toString('hex'), ...generateKeyPairSync('rsa', { modulusLength: 2048 }) };
  const tokens = new Set<string>();
  const signers = new Map<string, { version: string; key: KeyObject }>();
  const fail = (status: number, code: string, message: string): Reply => ({ status, body: { error: { code, message } } });
  let base = '';
  const oaep = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

  const s = await serve((req, raw, url) => {
    if (url.pathname === `/${tenantId}/oauth2/v2.0/token`) {
      const form = new URLSearchParams(raw.toString('utf8'));
      if (form.get('grant_type') !== 'client_credentials' || form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) {
        return { status: 401, body: { error: 'invalid_client' } };
      }
      const token = randomBytes(16).toString('hex');
      tokens.add(token);
      return { status: 200, body: { access_token: token, expires_in: 3599, token_type: 'Bearer' } };
    }
    if (url.searchParams.get('api-version') !== '7.4') return fail(400, 'BadParameter', 'api-version');
    if (!tokens.has(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))) return fail(401, 'Unauthorized', 'no token');
    const m = /^\/keys\/([^/]+)(?:\/([0-9a-f]{32}))?(?:\/(wrapkey|unwrapkey|sign))?$/.exec(url.pathname);
    if (!m) return fail(404, 'NotFound', url.pathname);
    const [, name, version, op] = m;
    const b = json(raw);
    const value = Buffer.from(String(b.value ?? ''), 'base64url');
    if (name === rsa.name && (version === undefined || version === rsa.version)) {
      const kid = `${base}/keys/${rsa.name}/${rsa.version}`;
      if (op === 'wrapkey' && b.alg === 'RSA-OAEP-256') return { status: 200, body: { kid, value: publicEncrypt({ key: rsa.publicKey, ...oaep }, value).toString('base64url') } };
      if (op === 'unwrapkey' && b.alg === 'RSA-OAEP-256') {
        try {
          return { status: 200, body: { kid, value: privateDecrypt({ key: rsa.privateKey, ...oaep }, value).toString('base64url') } };
        } catch {
          return fail(400, 'BadParameter', 'Error decrypting the key');
        }
      }
      return fail(400, 'BadParameter', `unsupported ${op ?? 'get'} on an RSA key`);
    }
    const signer = signers.get(name!);
    if (!signer || (version !== undefined && version !== signer.version)) return fail(404, 'KeyNotFound', `${name} not found`);
    const kid = `${base}/keys/${name}/${signer.version}`;
    if (op === 'sign' && b.alg === 'ES256' && value.length === 32) return { status: 200, body: { kid, value: Buffer.from(signP256Digest(signer.key, value)).toString('base64url') } };
    if (op === undefined) {
      const jwk = createPublicKey(signer.key).export({ format: 'jwk' });
      return { status: 200, body: { key: { kid, kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, key_ops: ['sign', 'verify'] } } };
    }
    return fail(400, 'BadParameter', `unsupported ${op}`);
  });
  base = s.url;
  return {
    url: s.url,
    tenantId,
    clientId,
    clientSecret,
    keyUrl: `${s.url}/keys/${rsa.name}`,
    get requests() {
      return s.count();
    },
    signingKey(name) {
      if (!signers.has(name)) signers.set(name, { version: randomBytes(16).toString('hex'), key: ecKey() });
      return `${s.url}/keys/${name}`;
    },
    close: s.close,
  };
}
