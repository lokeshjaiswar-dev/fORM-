import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUCKET_NAMES, type BucketName } from '@form/ports';
import { runKeyProviderContract, runStorageContract, s3PresignedClient } from '@form/testkit';
import { createEgressGuard } from '../src/egress/index.ts';
import {
  azureClientCredentialTokens,
  createAwsNativeSigner,
  createAwsRootKey,
  createAzureNativeSigner,
  createAzureRootKey,
  createGcpNativeSigner,
  createGcpRootKey,
  createKmsKeyProvider,
  gcpServiceAccountTokens,
  openSealedSigner,
  parseGcpServiceAccount,
  sealSigningSeed,
  type RootKey,
} from '../src/kms/index.ts';
import { createS3Storage } from '../src/storage/index.ts';

/**
 * The nightly real-account run (`.github/workflows/cloud-nightly.yml`, off unless the repository variable
 * FORM_CLOUD_NIGHTLY is 'true'): the same KeyProvider and Storage contracts the emulators and SeaweedFS pass, against
 * AWS KMS, Cloud KMS, Azure Key Vault and an S3 bucket with Object Lock. Each provider runs only when its FORM_CLOUD_*
 * variables are set, so `pnpm --filter @form/adapters test:cloud` is a no-op on a laptop.
 */
const env = process.env;
const egress = createEgressGuard({ policy: 'open' });
/** `audit-platform=<key>,templates-system=<key>`: the two signing keys the KeyProvider contract signs with. */
const keyMap = (v: string | undefined) => Object.fromEntries((v ?? '').split(',').filter(Boolean).map((p) => [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()]));

async function appHeld(root: RootKey) {
  return createKmsKeyProvider({ root, signer: await openSealedSigner(root, await sealSigningSeed(root)) });
}

const aws = env.FORM_CLOUD_AWS_KMS_KEY_ID && env.AWS_REGION ? { region: env.AWS_REGION, keyId: env.FORM_CLOUD_AWS_KMS_KEY_ID } : undefined;
if (aws) {
  runKeyProviderContract('AWS KMS (real account), app-held Ed25519', async () => ({ impl: await appHeld(createAwsRootKey({ ...aws, egress })) }));
  if (env.FORM_CLOUD_AWS_SIGNING_KEYS) {
    runKeyProviderContract('AWS KMS (real account), KMS-native ES256', () => ({
      impl: createKmsKeyProvider({ root: createAwsRootKey({ ...aws, egress }), signer: createAwsNativeSigner({ region: aws.region, egress, keys: keyMap(env.FORM_CLOUD_AWS_SIGNING_KEYS) }) }),
    }));
  }
}

const gcpCredentials = env.FORM_CLOUD_GCP_CREDENTIALS_FILE;
if (env.FORM_CLOUD_GCP_KMS_KEY && gcpCredentials) {
  const tokens = () => gcpServiceAccountTokens({ egress, credentials: parseGcpServiceAccount(readFileSync(gcpCredentials, 'utf8')) });
  runKeyProviderContract('Cloud KMS (real account), app-held Ed25519', async () => ({ impl: await appHeld(createGcpRootKey({ egress, tokens: tokens(), keyName: env.FORM_CLOUD_GCP_KMS_KEY! })) }));
  if (env.FORM_CLOUD_GCP_SIGNING_KEYS) {
    runKeyProviderContract('Cloud KMS (real account), KMS-native ES256', () => {
      const t = tokens();
      return {
        impl: createKmsKeyProvider({
          root: createGcpRootKey({ egress, tokens: t, keyName: env.FORM_CLOUD_GCP_KMS_KEY! }),
          signer: createGcpNativeSigner({ egress, tokens: t, keys: keyMap(env.FORM_CLOUD_GCP_SIGNING_KEYS) }),
        }),
      };
    });
  }
}

if (env.FORM_CLOUD_AZURE_KEY_URL && env.FORM_CLOUD_AZURE_TENANT_ID && env.FORM_CLOUD_AZURE_CLIENT_ID && env.FORM_CLOUD_AZURE_CLIENT_SECRET) {
  const tokens = () =>
    azureClientCredentialTokens({ egress, tenantId: env.FORM_CLOUD_AZURE_TENANT_ID!, clientId: env.FORM_CLOUD_AZURE_CLIENT_ID!, clientSecret: env.FORM_CLOUD_AZURE_CLIENT_SECRET! });
  runKeyProviderContract('Azure Key Vault (real account), app-held Ed25519', async () => ({ impl: await appHeld(createAzureRootKey({ egress, tokens: tokens(), keyUrl: env.FORM_CLOUD_AZURE_KEY_URL! })) }));
  if (env.FORM_CLOUD_AZURE_SIGNING_KEYS) {
    runKeyProviderContract('Azure Key Vault (real account), KMS-native ES256', () => {
      const t = tokens();
      return {
        impl: createKmsKeyProvider({
          root: createAzureRootKey({ egress, tokens: t, keyUrl: env.FORM_CLOUD_AZURE_KEY_URL! }),
          signer: createAzureNativeSigner({ egress, tokens: t, keys: keyMap(env.FORM_CLOUD_AZURE_SIGNING_KEYS) }),
        }),
      };
    });
  }
}

/** `FORM_CLOUD_S3_BUCKET_PREFIX`: six existing buckets `<prefix>-<bucket>`, the audit one created with Object Lock. */
const s3Prefix = env.FORM_CLOUD_S3_BUCKET_PREFIX;
if (s3Prefix && env.AWS_REGION) {
  const storage = () =>
    createS3Storage({
      region: env.AWS_REGION!,
      buckets: Object.fromEntries(BUCKET_NAMES.map((b) => [b, `${s3Prefix}-${b}`])) as Record<BucketName, string>,
      sse: { mode: 'aws:kms', kmsKeyId: env.FORM_CLOUD_S3_SSE_KMS_KEY_ID },
      egress,
    });
  runStorageContract('AWS S3 (real account)', () => ({ impl: storage(), presigned: s3PresignedClient() }));
  describe('AWS S3 (real account)', () => {
    it('has compliance-mode Object Lock on the audit bucket and versioned uploads', async () => {
      expect(await storage().capabilities()).toEqual({ objectLock: true, versioning: true, sse: true });
    });
  });
}

if (!aws && !env.FORM_CLOUD_GCP_KMS_KEY && !env.FORM_CLOUD_AZURE_KEY_URL && !s3Prefix) {
  describe('cloud accounts', () => {
    it.skip('run nightly with FORM_CLOUD_* set (.github/workflows/cloud-nightly.yml)', () => {});
  });
}
