import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { DecryptCommand, EncryptCommand, GetPublicKeyCommand, KMSClient, KMSServiceException, SignCommand } from '@aws-sdk/client-kms';
import { PortError, type EgressGuard } from '@form/ports';
import { assertEndpoint, egressLookup } from '../egress/http.ts';
import type { RootKey } from './envelope.ts';
import { checkKeyId, derToP1363, p256Point, type Signer } from './signing.ts';

export interface AwsKmsOptions {
  region: string;
  /** Key ARN, alias ARN or `alias/<name>` of the regional root key (`KMS_KEY_ID`). */
  keyId: string;
  /** Every KMS call passes the guard: the regional KMS endpoint must be reachable under `EGRESS_POLICY`. */
  egress: EgressGuard;
  /** A VPC endpoint, or the test emulator. Default: the public regional endpoint. */
  endpoint?: string | undefined;
  /**
   * Default: the SDK chain (environment, web identity / IRSA, instance profile). Its STS and metadata requests do not
   * pass the egress guard (architecture §6, BL-255), so `allowlist` and `none` installs set static keys.
   */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined;
  timeoutMs?: number;
}

/** The SDK client with every KMS connection behind the egress guard (credential resolution aside, see `credentials`). */
export function awsKmsClient(o: Omit<AwsKmsOptions, 'keyId'>): { client: KMSClient; ready: () => Promise<void> } {
  const endpoint = new URL(o.endpoint ?? `https://kms.${o.region}.amazonaws.com`);
  const protocol = endpoint.protocol === 'http:' ? 'http:' : 'https:';
  const lookup = egressLookup(o.egress, protocol, endpoint.port);
  const client = new KMSClient({
    region: o.region,
    ...(o.endpoint ? { endpoint: o.endpoint } : {}),
    ...(o.credentials ? { credentials: o.credentials } : {}),
    maxAttempts: 3,
    requestHandler: {
      requestTimeout: o.timeoutMs ?? 10_000,
      httpAgent: new HttpAgent({ keepAlive: true, lookup }),
      httpsAgent: new HttpsAgent({ keepAlive: true, lookup }),
    },
  });
  return { client, ready: assertEndpoint(o.egress, endpoint) };
}

function kmsError(e: unknown, what: string): PortError {
  if (e instanceof PortError) return e;
  if (e instanceof KMSServiceException) {
    if (e.name === 'InvalidCiphertextException' || e.name === 'IncorrectKeyException') return new PortError('integrity', `AWS KMS ${what}: ${e.name}`, { cause: e });
    if (e.name === 'NotFoundException') return new PortError('not_found', `AWS KMS ${what}: ${e.message}`, { cause: e });
  }
  return new PortError('unavailable', `AWS KMS ${what} failed: ${(e as Error).message}`, { cause: e });
}

/**
 * The regional AWS KMS key as the root key (SaaS). The AAD travels as the encryption context, so CloudTrail shows
 * which org each unwrap was for; `keyRef` is the key ARN the KMS answered.
 */
export function createAwsRootKey(o: AwsKmsOptions): RootKey {
  const { client, ready } = awsKmsClient(o);
  return {
    provider: 'aws',
    async encrypt(plaintext, aad) {
      try {
        await ready();
        const r = await client.send(new EncryptCommand({ KeyId: o.keyId, Plaintext: plaintext, EncryptionContext: { 'form:aad': aad } }));
        if (!r.CiphertextBlob || !r.KeyId) throw new PortError('unavailable', 'AWS KMS Encrypt answered without a ciphertext');
        return { ciphertext: r.CiphertextBlob, keyRef: r.KeyId };
      } catch (e) {
        throw kmsError(e, 'Encrypt');
      }
    },
    async decrypt(ciphertext, keyRef, aad) {
      if (!keyRef.startsWith('arn:aws') && keyRef !== o.keyId) throw new PortError('not_found', `not an AWS KMS key: ${keyRef}`);
      try {
        await ready();
        const r = await client.send(new DecryptCommand({ KeyId: keyRef, CiphertextBlob: ciphertext, EncryptionContext: { 'form:aad': aad } }));
        if (!r.Plaintext) throw new PortError('unavailable', 'AWS KMS Decrypt answered without a plaintext');
        return r.Plaintext;
      } catch (e) {
        throw kmsError(e, 'Decrypt');
      }
    },
  };
}

/** ES256 with KMS-held asymmetric keys (`ECC_NIST_P256`, `SIGN_VERIFY`), for policies that require a KMS-native signature. */
export function createAwsNativeSigner(o: Omit<AwsKmsOptions, 'keyId'> & { keys: Readonly<Record<string, string>> }): Signer {
  const { client, ready } = awsKmsClient(o);
  const publicKeys = new Map<string, Uint8Array>();
  const kmsKey = (keyId: string) => {
    const k = o.keys[checkKeyId(keyId)];
    if (!k) throw new PortError('not_found', `no KMS-native signing key is mapped for ${keyId}`);
    return k;
  };
  return {
    async sign(keyId, data) {
      const KeyId = kmsKey(keyId);
      try {
        await ready();
        const r = await client.send(new SignCommand({ KeyId, Message: data, MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256' }));
        if (!r.Signature) throw new PortError('unavailable', 'AWS KMS Sign answered without a signature');
        return { alg: 'es256', signature: derToP1363(r.Signature) };
      } catch (e) {
        throw kmsError(e, 'Sign');
      }
    },
    async publicKey(keyId) {
      const KeyId = kmsKey(keyId);
      let key = publicKeys.get(keyId);
      if (!key) {
        try {
          await ready();
          const r = await client.send(new GetPublicKeyCommand({ KeyId }));
          if (!r.PublicKey) throw new PortError('unavailable', 'AWS KMS GetPublicKey answered without a key');
          key = p256Point(r.PublicKey);
        } catch (e) {
          throw kmsError(e, 'GetPublicKey');
        }
        publicKeys.set(keyId, key);
      }
      return { alg: 'es256', key };
    },
  };
}
