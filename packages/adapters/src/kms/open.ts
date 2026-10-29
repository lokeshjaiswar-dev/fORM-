import { readFile } from 'node:fs/promises';
import type { KmsConfig } from '@form/config';
import { PortError, type EgressGuard, type KeyProvider } from '@form/ports';
import { createAwsNativeSigner, createAwsRootKey } from './aws.ts';
import { createAzureNativeSigner, createAzureRootKey } from './azure.ts';
import { createKmsKeyProvider, openSealedSigner, type RootKey } from './envelope.ts';
import { createGcpNativeSigner, createGcpRootKey } from './gcp.ts';
import { loadKeyfileKeyProvider } from './keyfile.ts';
import { azureClientCredentialTokens, gcpServiceAccountTokens, parseGcpServiceAccount, type RestOptions, type TokenSource } from './rest.ts';
import type { Signer } from './signing.ts';
import { createVaultNativeSigner, createVaultRootKey, vaultKubernetesTokens, vaultStaticToken } from './vault.ts';

export interface OpenKeyProviderDeps {
  /** Every KMS call passes it; the keyfile driver makes none. */
  egress: EgressGuard;
  readFile?: (path: string) => Promise<string>;
}

type CloudConfig = Exclude<KmsConfig, { driver: 'keyfile' }>;

/** The root key and, for `kms-native` signing, the native signer of a cloud or Vault config. */
async function parts(c: CloudConfig, rest: RestOptions, read: (p: string) => Promise<string>): Promise<{ root: RootKey; native: (keys: Record<string, string>) => Signer }> {
  switch (c.driver) {
    case 'aws': {
      const o = { region: c.region, egress: rest.egress, endpoint: c.endpoint };
      return { root: createAwsRootKey({ ...o, keyId: c.keyId }), native: (keys) => createAwsNativeSigner({ ...o, keys }) };
    }
    case 'gcp': {
      const tokens = gcpServiceAccountTokens({ ...rest, credentials: parseGcpServiceAccount(await read(c.credentialsFile)) });
      const o = { ...rest, tokens, endpoint: c.endpoint };
      return { root: createGcpRootKey({ ...o, keyName: c.keyName }), native: (keys) => createGcpNativeSigner({ ...o, keys }) };
    }
    case 'azure': {
      const tokens = azureClientCredentialTokens({
        ...rest,
        tenantId: c.tenantId,
        clientId: c.clientId,
        clientSecret: (await read(c.clientSecretFile)).trim(),
        ...(c.authorityUrl ? { authorityUrl: c.authorityUrl } : {}),
      });
      return { root: createAzureRootKey({ ...rest, tokens, keyUrl: c.keyUrl }), native: (keys) => createAzureNativeSigner({ ...rest, tokens, keys }) };
    }
    case 'vault': {
      const r = { ...rest, ...(c.caFile ? { ca: await read(c.caFile) } : {}) };
      const auth = c.auth;
      const tokens: TokenSource =
        auth.kind === 'token'
          ? vaultStaticToken(await read(auth.tokenFile))
          : vaultKubernetesTokens({ ...r, address: c.address, role: auth.role, authMount: auth.mount, namespace: c.namespace, jwt: () => read(auth.jwtFile) });
      const o = { ...r, address: c.address, mount: c.mount, tokens, namespace: c.namespace };
      return { root: createVaultRootKey({ ...o, key: c.key }), native: (keys) => createVaultNativeSigner({ ...o, keys }) };
    }
  }
}

/**
 * The KeyProvider of `KMS_DRIVER` (architecture §1.5, §6). App-held signing (the default) unwraps the sealed seed
 * here, once, so a KMS that cannot be reached or a seed sealed by another key fails the boot, not the first checkpoint.
 */
export async function openKeyProvider(c: KmsConfig, deps: OpenKeyProviderDeps): Promise<KeyProvider> {
  const read = deps.readFile ?? ((p: string) => readFile(p, 'utf8'));
  if (c.driver === 'keyfile') {
    if (!c.keyfilePath) throw new PortError('invalid_argument', 'KMS_KEYFILE_PATH is not set');
    return loadKeyfileKeyProvider(c.keyfilePath);
  }
  const { root, native } = await parts(c, { egress: deps.egress }, read);
  const signer = c.signing.mode === 'app' ? await openSealedSigner(root, await read(c.signing.seedFile)) : native(c.signing.keys);
  return createKmsKeyProvider({ root, signer });
}

/** The root key of a cloud or Vault config alone, for `form-admin keys init` and the nightly job: they seal a seed with it. */
export async function openRootKey(c: CloudConfig, deps: OpenKeyProviderDeps): Promise<RootKey> {
  return (await parts(c, { egress: deps.egress }, deps.readFile ?? ((p: string) => readFile(p, 'utf8')))).root;
}
