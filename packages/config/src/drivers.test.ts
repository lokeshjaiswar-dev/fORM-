import { describe, expect, it } from 'vitest';
import { parseKmsConfig, parseStorageConfig } from './index.ts';

const errorsOf = (r: { ok: true } | { ok: false; errors: string[] }) => (r.ok ? [] : r.errors);

describe('KMS config', () => {
  it('defaults to the keyfile', () => {
    expect(parseKmsConfig({})).toEqual({ ok: true, config: { driver: 'keyfile', keyfilePath: undefined } });
    expect(parseKmsConfig({ KMS_KEYFILE_PATH: '/k' })).toEqual({ ok: true, config: { driver: 'keyfile', keyfilePath: '/k' } });
    expect(errorsOf(parseKmsConfig({ KMS_SIGNING: 'kms-native' }))).toEqual([expect.stringMatching(/^KMS_SIGNING: kms-native needs a KMS/)]);
  });

  it('reads each cloud driver with app-held or KMS-native signing', () => {
    expect(parseKmsConfig({ KMS_DRIVER: 'aws', AWS_REGION: 'ap-south-1', KMS_KEY_ID: 'alias/root', KMS_SIGNING_SEED_FILE: '/seed' })).toEqual({
      ok: true,
      config: { driver: 'aws', region: 'ap-south-1', keyId: 'alias/root', endpoint: undefined, signing: { mode: 'app', seedFile: '/seed' } },
    });
    const native = parseKmsConfig({
      KMS_DRIVER: 'azure',
      KMS_KEY_ID: 'https://acme.vault.azure.net/keys/root',
      KMS_AZURE_TENANT_ID: 't',
      KMS_AZURE_CLIENT_ID: 'c',
      KMS_AZURE_CLIENT_SECRET_FILE: '/s',
      KMS_SIGNING: 'kms-native',
      KMS_NATIVE_SIGNING_KEYS: 'audit-v1=https://acme.vault.azure.net/keys/audit, templates-system=https://acme.vault.azure.net/keys/tpl',
    });
    expect(native.ok && native.config).toMatchObject({
      driver: 'azure',
      signing: { mode: 'kms-native', keys: { 'audit-v1': 'https://acme.vault.azure.net/keys/audit', 'templates-system': 'https://acme.vault.azure.net/keys/tpl' } },
    });
    const vault = parseKmsConfig({ KMS_DRIVER: 'vault', VAULT_ADDR: 'https://vault.corp.local:8200', KMS_KEY_ID: 'form-root', KMS_VAULT_AUTH: 'kubernetes', KMS_VAULT_ROLE: 'form', KMS_SIGNING_SEED_FILE: '/seed' });
    expect(vault.ok && vault.config).toMatchObject({ address: 'https://vault.corp.local:8200', mount: 'transit', auth: { kind: 'kubernetes', role: 'form', mount: 'kubernetes' } });
    const gcp = parseKmsConfig({ KMS_DRIVER: 'gcp', KMS_KEY_ID: 'projects/p/locations/l/keyRings/r/cryptoKeys/k', KMS_GCP_CREDENTIALS_FILE: '/gcp.json', KMS_SIGNING_SEED_FILE: '/seed' });
    expect(gcp.ok && gcp.config).toMatchObject({ driver: 'gcp', credentialsFile: '/gcp.json' });
  });

  it('reports every missing setting at once', () => {
    expect(errorsOf(parseKmsConfig({ KMS_DRIVER: 'aws' }))).toEqual([
      'KMS_SIGNING_SEED_FILE: is required with KMS_DRIVER=aws (the app-held signing seed, sealed by the KMS)',
      'KMS_REGION: is required with KMS_DRIVER=aws (or AWS_REGION)',
      'KMS_KEY_ID: is required with KMS_DRIVER=aws',
    ]);
    expect(errorsOf(parseKmsConfig({ KMS_DRIVER: 'gcp', KMS_SIGNING: 'kms-native', KMS_NATIVE_SIGNING_KEYS: 'audit-v1, =x' }))).toEqual(
      expect.arrayContaining([
        'KMS_NATIVE_SIGNING_KEYS: expected keyId=<provider key>, got "audit-v1"',
        'KMS_NATIVE_SIGNING_KEYS: expected keyId=<provider key>, got "=x"',
        expect.stringMatching(/^KMS_GCP_CREDENTIALS_FILE: is required/),
      ]),
    );
    expect(errorsOf(parseKmsConfig({ KMS_DRIVER: 'hsm' }))).toEqual([expect.stringMatching(/^KMS_DRIVER: /)]);
  });
});

describe('storage config', () => {
  it('is optional, and the filesystem store needs a root', () => {
    expect(parseStorageConfig({})).toEqual({ ok: true, config: undefined });
    expect(errorsOf(parseStorageConfig({ STORAGE_DRIVER: 'filesystem' }))).toEqual(['STORAGE_ROOT: is required with STORAGE_DRIVER=filesystem']);
  });

  it('defaults S3 bucket names and path style for a bring-your-own store', () => {
    const r = parseStorageConfig({ STORAGE_DRIVER: 's3', STORAGE_ENDPOINT: 'https://s3.corp.local', STORAGE_BUCKET_AUDIT: 'acme-audit', STORAGE_SSE: 'aws:kms', STORAGE_SSE_KMS_KEY_ID: 'k' });
    expect(r.ok && r.config).toEqual({
      driver: 's3',
      region: 'ap-south-1',
      endpoint: 'https://s3.corp.local',
      forcePathStyle: true,
      publicEndpoint: undefined,
      credentials: undefined,
      buckets: { staging: 'fr-staging', uploads: 'fr-uploads', assets: 'fr-assets', exports: 'fr-exports', audit: 'acme-audit', packs: 'fr-packs' },
      sse: { mode: 'aws:kms', kmsKeyId: 'k' },
    });
  });

  it('refuses half credentials, shared bucket names and a KMS key without SSE-KMS', () => {
    expect(errorsOf(parseStorageConfig({ STORAGE_DRIVER: 's3', STORAGE_ACCESS_KEY_ID: 'a', STORAGE_BUCKET_UPLOADS: 'fr-assets', STORAGE_SSE_KMS_KEY_ID: 'k' }))).toEqual([
      'STORAGE_SECRET_ACCESS_KEY_FILE: goes together with STORAGE_ACCESS_KEY_ID',
      'STORAGE_SSE_KMS_KEY_ID: needs STORAGE_SSE=aws:kms',
      'STORAGE_BUCKET_*: every bucket needs its own name',
    ]);
    expect(errorsOf(parseStorageConfig({ STORAGE_DRIVER: 's3', STORAGE_BUCKET_AUDIT: 'Bad_Name' }))).toEqual([expect.stringMatching(/^STORAGE_BUCKET_AUDIT: expected an S3 bucket name/)]);
  });
});
