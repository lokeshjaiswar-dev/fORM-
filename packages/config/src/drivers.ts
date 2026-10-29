import { BUCKET_NAMES, type BucketName } from '@form/ports';
import { z } from 'zod';

/** Adapter drivers the api and the worker share (architecture §1.5, §6): the KMS and object storage. */

export const KMS_DRIVERS = ['aws', 'gcp', 'azure', 'vault', 'keyfile'] as const;
export type KmsDriver = (typeof KMS_DRIVERS)[number];

/**
 * How signing keys are held: `app` (default) derives app-held Ed25519 keys from a seed the KMS keeps wrapped
 * (`KMS_SIGNING_SEED_FILE`); `kms-native` signs ES256 inside the KMS with the keys `KMS_NATIVE_SIGNING_KEYS` maps.
 * The keyfile driver derives its signing keys from the master key.
 */
export type KmsSigningConfig = { mode: 'app'; seedFile: string } | { mode: 'kms-native'; keys: Record<string, string> };

export type VaultAuthConfig = { kind: 'token'; tokenFile: string } | { kind: 'kubernetes'; role: string; jwtFile: string; mount: string };

export type KmsConfig =
  | { driver: 'keyfile'; keyfilePath: string | undefined }
  | { driver: 'aws'; region: string; keyId: string; endpoint: string | undefined; signing: KmsSigningConfig }
  | { driver: 'gcp'; keyName: string; credentialsFile: string; endpoint: string | undefined; signing: KmsSigningConfig }
  | {
      driver: 'azure';
      keyUrl: string;
      tenantId: string;
      clientId: string;
      clientSecretFile: string;
      authorityUrl: string | undefined;
      signing: KmsSigningConfig;
    }
  | {
      driver: 'vault';
      address: string;
      mount: string;
      key: string;
      auth: VaultAuthConfig;
      caFile: string | undefined;
      namespace: string | undefined;
      signing: KmsSigningConfig;
    };

const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const opt = z.string().min(1).optional();

export const kmsEnvSchema = z.object({
  KMS_DRIVER: z.enum(KMS_DRIVERS).default('keyfile'),
  /** aws: key ARN or alias; gcp: `projects/…/cryptoKeys/<key>`; azure: `https://<vault>.vault.azure.net/keys/<name>`; vault: transit key name. */
  KMS_KEY_ID: opt,
  KMS_KEYFILE_PATH: opt,
  /** A VPC/PSC endpoint, or an emulator in tests (aws, gcp). */
  KMS_ENDPOINT: z.url().optional(),
  KMS_REGION: opt,
  AWS_REGION: opt,
  KMS_SIGNING: z.enum(['app', 'kms-native']).default('app'),
  KMS_SIGNING_SEED_FILE: opt,
  /** `keyId=<provider key>` pairs, comma-separated, e.g. `audit-v1=arn:aws:kms:ap-south-1:…:key/…`. */
  KMS_NATIVE_SIGNING_KEYS: opt,
  KMS_GCP_CREDENTIALS_FILE: opt,
  KMS_AZURE_TENANT_ID: opt,
  KMS_AZURE_CLIENT_ID: opt,
  KMS_AZURE_CLIENT_SECRET_FILE: opt,
  KMS_AZURE_AUTHORITY_URL: z.url().optional(),
  KMS_VAULT_ADDR: z.url().optional(),
  VAULT_ADDR: z.url().optional(),
  KMS_VAULT_MOUNT: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).default('transit'),
  KMS_VAULT_AUTH: z.enum(['token', 'kubernetes']).default('token'),
  KMS_VAULT_TOKEN_FILE: opt,
  KMS_VAULT_ROLE: opt,
  KMS_VAULT_JWT_FILE: z.string().min(1).default('/var/run/secrets/kubernetes.io/serviceaccount/token'),
  KMS_VAULT_AUTH_MOUNT: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).default('kubernetes'),
  KMS_VAULT_CA_FILE: opt,
  KMS_VAULT_NAMESPACE: opt,
});

type KmsEnv = z.infer<typeof kmsEnvSchema>;

function nativeKeys(v: string | undefined, errors: string[]): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const pair of (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf('=');
    const id = pair.slice(0, i);
    if (i <= 0 || !KEY_ID.test(id) || pair.length === i + 1) errors.push(`KMS_NATIVE_SIGNING_KEYS: expected keyId=<provider key>, got ${JSON.stringify(pair)}`);
    else keys[id] = pair.slice(i + 1);
  }
  return keys;
}

/** The KMS settings, or every problem with them. Paths are read by the adapter at boot, not here. */
export function kmsConfigFrom(e: KmsEnv): { ok: true; config: KmsConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const need = (key: keyof KmsEnv, why: string): string => {
    const v = e[key];
    if (typeof v !== 'string' || v.length === 0) errors.push(`${key}: is required with KMS_DRIVER=${e.KMS_DRIVER}${why ? ` (${why})` : ''}`);
    return typeof v === 'string' ? v : '';
  };
  if (e.KMS_DRIVER === 'keyfile') {
    if (e.KMS_SIGNING === 'kms-native') errors.push('KMS_SIGNING: kms-native needs a KMS; the keyfile driver signs with keys derived from the master key');
    return errors.length ? { ok: false, errors } : { ok: true, config: { driver: 'keyfile', keyfilePath: e.KMS_KEYFILE_PATH } };
  }
  const signing: KmsSigningConfig =
    e.KMS_SIGNING === 'app'
      ? { mode: 'app', seedFile: need('KMS_SIGNING_SEED_FILE', 'the app-held signing seed, sealed by the KMS') }
      : { mode: 'kms-native', keys: nativeKeys(need('KMS_NATIVE_SIGNING_KEYS', 'KMS_SIGNING=kms-native'), errors) };
  let config: KmsConfig;
  switch (e.KMS_DRIVER) {
    case 'aws': {
      const region = e.KMS_REGION ?? e.AWS_REGION;
      if (!region) errors.push('KMS_REGION: is required with KMS_DRIVER=aws (or AWS_REGION)');
      config = { driver: 'aws', region: region ?? '', keyId: need('KMS_KEY_ID', ''), endpoint: e.KMS_ENDPOINT, signing };
      break;
    }
    case 'gcp':
      config = {
        driver: 'gcp',
        keyName: need('KMS_KEY_ID', 'projects/…/cryptoKeys/<key>'),
        credentialsFile: need('KMS_GCP_CREDENTIALS_FILE', 'a service-account key'),
        endpoint: e.KMS_ENDPOINT,
        signing,
      };
      break;
    case 'azure':
      config = {
        driver: 'azure',
        keyUrl: need('KMS_KEY_ID', 'https://<vault>.vault.azure.net/keys/<name>'),
        tenantId: need('KMS_AZURE_TENANT_ID', ''),
        clientId: need('KMS_AZURE_CLIENT_ID', ''),
        clientSecretFile: need('KMS_AZURE_CLIENT_SECRET_FILE', ''),
        authorityUrl: e.KMS_AZURE_AUTHORITY_URL,
        signing,
      };
      break;
    case 'vault': {
      const address = e.KMS_VAULT_ADDR ?? e.VAULT_ADDR;
      if (!address) errors.push('KMS_VAULT_ADDR: is required with KMS_DRIVER=vault (or VAULT_ADDR)');
      config = {
        driver: 'vault',
        address: address ?? '',
        mount: e.KMS_VAULT_MOUNT,
        key: need('KMS_KEY_ID', 'the transit key name'),
        auth:
          e.KMS_VAULT_AUTH === 'token'
            ? { kind: 'token', tokenFile: need('KMS_VAULT_TOKEN_FILE', 'KMS_VAULT_AUTH=token') }
            : { kind: 'kubernetes', role: need('KMS_VAULT_ROLE', 'KMS_VAULT_AUTH=kubernetes'), jwtFile: e.KMS_VAULT_JWT_FILE, mount: e.KMS_VAULT_AUTH_MOUNT },
        caFile: e.KMS_VAULT_CA_FILE,
        namespace: e.KMS_VAULT_NAMESPACE,
        signing,
      };
      break;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, config };
}

export const STORAGE_DRIVERS = ['s3', 'filesystem'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

export type StorageSse = { mode: 'aws:kms'; kmsKeyId: string | undefined } | { mode: 'AES256' };

export type StorageConfig =
  | { driver: 'filesystem'; root: string }
  | {
      driver: 's3';
      region: string;
      /** Unset: AWS S3. Set: a bring-your-own S3-compatible store (ADR-0018), path-style unless told otherwise. */
      endpoint: string | undefined;
      forcePathStyle: boolean;
      /** Where browsers reach the store when it differs from `endpoint` (presigned URLs). */
      publicEndpoint: string | undefined;
      /** Unset: the SDK chain (IRSA, instance profile, environment). */
      credentials: { accessKeyId: string; secretAccessKeyFile: string } | undefined;
      buckets: Record<BucketName, string>;
      sse: StorageSse | undefined;
    };

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const bucketEnv = Object.fromEntries(BUCKET_NAMES.map((b) => [`STORAGE_BUCKET_${b.toUpperCase()}`, z.string().regex(BUCKET, 'expected an S3 bucket name').optional()])) as Record<
  `STORAGE_BUCKET_${Uppercase<BucketName>}`,
  z.ZodOptional<z.ZodString>
>;

export const storageEnvSchema = z.object({
  STORAGE_DRIVER: z.enum(STORAGE_DRIVERS).optional(),
  STORAGE_ROOT: opt,
  STORAGE_ENDPOINT: z.url().optional(),
  STORAGE_PUBLIC_ENDPOINT: z.url().optional(),
  STORAGE_REGION: z.string().min(1).default('ap-south-1'),
  STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).optional(),
  STORAGE_ACCESS_KEY_ID: opt,
  STORAGE_SECRET_ACCESS_KEY_FILE: opt,
  STORAGE_SSE: z.enum(['none', 'aws:kms', 'AES256']).default('none'),
  STORAGE_SSE_KMS_KEY_ID: opt,
  ...bucketEnv,
});

type StorageEnv = z.infer<typeof storageEnvSchema>;

/** Undefined when no store is configured. Bucket names default to `fr-<bucket>`. */
export function storageConfigFrom(e: StorageEnv): { ok: true; config: StorageConfig | undefined } | { ok: false; errors: string[] } {
  if (!e.STORAGE_DRIVER) return { ok: true, config: undefined };
  if (e.STORAGE_DRIVER === 'filesystem') {
    return e.STORAGE_ROOT ? { ok: true, config: { driver: 'filesystem', root: e.STORAGE_ROOT } } : { ok: false, errors: ['STORAGE_ROOT: is required with STORAGE_DRIVER=filesystem'] };
  }
  const errors: string[] = [];
  if (!e.STORAGE_ACCESS_KEY_ID !== !e.STORAGE_SECRET_ACCESS_KEY_FILE) errors.push('STORAGE_SECRET_ACCESS_KEY_FILE: goes together with STORAGE_ACCESS_KEY_ID');
  if (e.STORAGE_SSE !== 'aws:kms' && e.STORAGE_SSE_KMS_KEY_ID) errors.push('STORAGE_SSE_KMS_KEY_ID: needs STORAGE_SSE=aws:kms');
  const buckets = Object.fromEntries(BUCKET_NAMES.map((b) => [b, e[`STORAGE_BUCKET_${b.toUpperCase() as Uppercase<BucketName>}`] ?? `fr-${b}`])) as Record<BucketName, string>;
  if (new Set(Object.values(buckets)).size !== BUCKET_NAMES.length) errors.push('STORAGE_BUCKET_*: every bucket needs its own name');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: {
      driver: 's3',
      region: e.STORAGE_REGION,
      endpoint: e.STORAGE_ENDPOINT,
      forcePathStyle: e.STORAGE_FORCE_PATH_STYLE ? e.STORAGE_FORCE_PATH_STYLE === 'true' : e.STORAGE_ENDPOINT !== undefined,
      publicEndpoint: e.STORAGE_PUBLIC_ENDPOINT,
      credentials: e.STORAGE_ACCESS_KEY_ID && e.STORAGE_SECRET_ACCESS_KEY_FILE ? { accessKeyId: e.STORAGE_ACCESS_KEY_ID, secretAccessKeyFile: e.STORAGE_SECRET_ACCESS_KEY_FILE } : undefined,
      buckets,
      sse: e.STORAGE_SSE === 'none' ? undefined : e.STORAGE_SSE === 'AES256' ? { mode: 'AES256' } : { mode: 'aws:kms', kmsKeyId: e.STORAGE_SSE_KMS_KEY_ID },
    },
  };
}

const issues = (r: { error: z.ZodError }) => r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
const clean = (env: Record<string, string | undefined>) => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));

export function parseKmsConfig(env: Record<string, string | undefined>): { ok: true; config: KmsConfig } | { ok: false; errors: string[] } {
  const r = kmsEnvSchema.safeParse(clean(env));
  return r.success ? kmsConfigFrom(r.data) : { ok: false, errors: issues(r) };
}

export function parseStorageConfig(env: Record<string, string | undefined>): { ok: true; config: StorageConfig | undefined } | { ok: false; errors: string[] } {
  const r = storageEnvSchema.safeParse(clean(env));
  return r.success ? storageConfigFrom(r.data) : { ok: false, errors: issues(r) };
}
