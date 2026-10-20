import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  expectPortError,
  runKeyProviderContract,
  startAwsKmsEmulator,
  startAzureKeyVaultEmulator,
  startGcpKmsEmulator,
  utf8,
  verifySignature,
} from '@form/testkit';
import { createEgressGuard } from '../egress/guard.ts';
import { createAwsNativeSigner, createAwsRootKey } from './aws.ts';
import { createAzureNativeSigner, createAzureRootKey } from './azure.ts';
import { createKmsKeyProvider, openSealedSigner, sealSigningSeed, type RootKey } from './envelope.ts';
import { createGcpNativeSigner, createGcpRootKey } from './gcp.ts';
import { openKeyProvider } from './open.ts';
import { azureClientCredentialTokens, gcpServiceAccountTokens, parseGcpServiceAccount } from './rest.ts';
import { createVaultRootKey, vaultKubernetesTokens } from './vault.ts';

const egress = createEgressGuard({ policy: 'allowlist', allowlist: ['127.0.0.1'] });
const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'emulator-secret' };
const CONTRACT_KEYS = ['audit-platform', 'templates-system'];
const org = { orgId: '0190f1d2-0000-7000-8000-000000000001' };

async function withSealedSeed(root: RootKey) {
  return createKmsKeyProvider({ root, signer: await openSealedSigner(root, await sealSigningSeed(root)) });
}

runKeyProviderContract('AWS KMS (emulated), app-held Ed25519', async () => {
  const kms = await startAwsKmsEmulator();
  const root = createAwsRootKey({ region: kms.region, keyId: kms.keyId, endpoint: kms.url, credentials, egress });
  return { impl: await withSealedSeed(root), dispose: () => kms.close() };
});

runKeyProviderContract('AWS KMS (emulated), KMS-native ES256', async () => {
  const kms = await startAwsKmsEmulator();
  const o = { region: kms.region, endpoint: kms.url, credentials, egress };
  const keys = Object.fromEntries(CONTRACT_KEYS.map((k) => [k, kms.signingKey(k)]));
  return { impl: createKmsKeyProvider({ root: createAwsRootKey({ ...o, keyId: kms.keyId }), signer: createAwsNativeSigner({ ...o, keys }) }), dispose: () => kms.close() };
});

runKeyProviderContract('Cloud KMS (emulated), app-held Ed25519', async () => {
  const kms = await startGcpKmsEmulator();
  const tokens = gcpServiceAccountTokens({ egress, credentials: parseGcpServiceAccount(kms.credentials) });
  return { impl: await withSealedSeed(createGcpRootKey({ egress, tokens, keyName: kms.keyName, endpoint: kms.url })), dispose: () => kms.close() };
});

runKeyProviderContract('Cloud KMS (emulated), KMS-native ES256', async () => {
  const kms = await startGcpKmsEmulator();
  const tokens = gcpServiceAccountTokens({ egress, credentials: parseGcpServiceAccount(kms.credentials) });
  const keys = Object.fromEntries(CONTRACT_KEYS.map((k) => [k, kms.signingKey(k)]));
  return {
    impl: createKmsKeyProvider({
      root: createGcpRootKey({ egress, tokens, keyName: kms.keyName, endpoint: kms.url }),
      signer: createGcpNativeSigner({ egress, tokens, endpoint: kms.url, keys }),
    }),
    dispose: () => kms.close(),
  };
});

runKeyProviderContract('Azure Key Vault (emulated), app-held Ed25519', async () => {
  const kv = await startAzureKeyVaultEmulator();
  const tokens = azureClientCredentialTokens({ egress, tenantId: kv.tenantId, clientId: kv.clientId, clientSecret: kv.clientSecret, authorityUrl: kv.url });
  return { impl: await withSealedSeed(createAzureRootKey({ egress, tokens, keyUrl: kv.keyUrl })), dispose: () => kv.close() };
});

runKeyProviderContract('Azure Key Vault (emulated), KMS-native ES256', async () => {
  const kv = await startAzureKeyVaultEmulator();
  const tokens = azureClientCredentialTokens({ egress, tenantId: kv.tenantId, clientId: kv.clientId, clientSecret: kv.clientSecret, authorityUrl: kv.url });
  const keys = Object.fromEntries(CONTRACT_KEYS.map((k) => [k, kv.signingKey(k)]));
  return {
    impl: createKmsKeyProvider({ root: createAzureRootKey({ egress, tokens, keyUrl: kv.keyUrl }), signer: createAzureNativeSigner({ egress, tokens, keys }) }),
    dispose: () => kv.close(),
  };
});

describe('cloud KMS drivers', () => {
  it('never call a KMS the egress guard denies', async () => {
    const kms = await startAwsKmsEmulator();
    try {
      const denied = createEgressGuard({ policy: 'none', allowlist: [] });
      const root = createAwsRootKey({ region: kms.region, keyId: kms.keyId, endpoint: kms.url, credentials, egress: denied });
      await expectPortError(root.encrypt(utf8('k'), 'aad'), 'egress_denied');
      const gcp = await startGcpKmsEmulator();
      const tokens = gcpServiceAccountTokens({ egress: denied, credentials: parseGcpServiceAccount(gcp.credentials) });
      await expectPortError(createGcpRootKey({ egress: denied, tokens, keyName: gcp.keyName, endpoint: gcp.url }).encrypt(utf8('k'), 'aad'), 'egress_denied');
      expect(kms.requests + gcp.requests).toBe(0);
      await gcp.close();
    } finally {
      await kms.close();
    }
  });

  it('fetches a new token after a 401', async () => {
    const kms = await startGcpKmsEmulator();
    try {
      const tokens = gcpServiceAccountTokens({ egress, credentials: parseGcpServiceAccount(kms.credentials) });
      const root = createGcpRootKey({ egress, tokens, keyName: kms.keyName, endpoint: kms.url });
      const { ciphertext, keyRef } = await root.encrypt(utf8('secret'), 'aad');
      kms.revokeTokens();
      expect(new TextDecoder().decode(await root.decrypt(ciphertext, keyRef, 'aad'))).toBe('secret');
    } finally {
      await kms.close();
    }
  });

  it('refuse key refs of other keys and signing keys nobody mapped', async () => {
    const kv = await startAzureKeyVaultEmulator();
    try {
      const tokens = azureClientCredentialTokens({ egress, tenantId: kv.tenantId, clientId: kv.clientId, clientSecret: kv.clientSecret, authorityUrl: kv.url });
      const root = createAzureRootKey({ egress, tokens, keyUrl: kv.keyUrl });
      const { ciphertext } = await root.encrypt(utf8('k'), 'aad');
      await expectPortError(root.decrypt(ciphertext, `${kv.url}/keys/other/${'0'.repeat(32)}`, 'aad'), 'not_found');
      await expectPortError(createAzureNativeSigner({ egress, tokens, keys: {} }).sign('audit-v1', utf8('x')), 'not_found');
      expect(() => createAzureRootKey({ egress, tokens, keyUrl: 'https://vault/notakey' })).toThrow(/keys\/<name>/);
      expect(() => createGcpRootKey({ egress, tokens, keyName: 'root' })).toThrow(/cryptoKeys/);
    } finally {
      await kv.close();
    }
  });

  it('keeps the app-held signing keys across restarts, and refuses a seed sealed by another provider', async () => {
    const aws = await startAwsKmsEmulator();
    const gcp = await startGcpKmsEmulator();
    try {
      const root = createAwsRootKey({ region: aws.region, keyId: aws.keyId, endpoint: aws.url, credentials, egress });
      const sealed = await sealSigningSeed(root);
      const a = await openSealedSigner(root, sealed);
      const b = await openSealedSigner(root, sealed);
      const sig = await a.sign('audit-v1', utf8('cp'));
      expect(await verifySignature('ed25519', (await b.publicKey('audit-v1')).key, sig.signature, utf8('cp'))).toBe(true);
      const tokens = gcpServiceAccountTokens({ egress, credentials: parseGcpServiceAccount(gcp.credentials) });
      await expect(openSealedSigner(createGcpRootKey({ egress, tokens, keyName: gcp.keyName, endpoint: gcp.url }), sealed)).rejects.toThrow(/sealed by aws/);
      await expect(openSealedSigner(root, 'not json')).rejects.toThrow(/not JSON/);
    } finally {
      await aws.close();
      await gcp.close();
    }
  });

  it('logs in to Vault with the pod service-account JWT, and again once the token is refused', async () => {
    const logins: unknown[] = [];
    let valid = 'tok-1';
    const server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/auth/kubernetes/login') {
          logins.push(JSON.parse(Buffer.concat(parts).toString('utf8')));
          valid = `tok-${logins.length}`;
          return res.end(JSON.stringify({ auth: { client_token: valid, lease_duration: 3600 } }));
        }
        if (req.headers['x-vault-token'] !== valid) return res.writeHead(403).end(JSON.stringify({ errors: ['permission denied'] }));
        res.end(JSON.stringify({ data: { ciphertext: 'vault:v1:AAAA' } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const tokens = vaultKubernetesTokens({ egress, address, role: 'form', jwt: async () => 'sa-jwt\n' });
      const root = createVaultRootKey({ egress, address, tokens, key: 'form-root' });
      await root.encrypt(utf8('k'), 'aad');
      valid = 'rotated-away';
      await root.encrypt(utf8('k'), 'aad');
      expect(logins).toEqual([
        { role: 'form', jwt: 'sa-jwt' },
        { role: 'form', jwt: 'sa-jwt' },
      ]);
    } finally {
      server.close();
    }
  });

  it('opens a provider from KMS_* config, reading its secrets from files', async () => {
    const kms = await startGcpKmsEmulator();
    try {
      const tokens = gcpServiceAccountTokens({ egress, credentials: parseGcpServiceAccount(kms.credentials) });
      const files: Record<string, string> = {
        '/run/secrets/gcp.json': kms.credentials,
        '/run/secrets/seed': await sealSigningSeed(createGcpRootKey({ egress, tokens, keyName: kms.keyName, endpoint: kms.url })),
      };
      const provider = await openKeyProvider(
        { driver: 'gcp', keyName: kms.keyName, credentialsFile: '/run/secrets/gcp.json', endpoint: kms.url, signing: { mode: 'app', seedFile: '/run/secrets/seed' } },
        { egress, readFile: async (p) => files[p] ?? Promise.reject(new Error(`ENOENT ${p}`)) },
      );
      const dek = randomBytes(32);
      const { wrapped, kekRef } = await provider.wrap(dek, org);
      expect(kekRef).toBe(`gcp:${kms.keyName}`);
      expect(await provider.unwrap(wrapped, kekRef, org)).toEqual(new Uint8Array(dek));
      await expectPortError(openKeyProvider({ driver: 'keyfile', keyfilePath: undefined }, { egress }), 'invalid_argument');
    } finally {
      await kms.close();
    }
  });
});
