import { readFile } from 'node:fs/promises';
import type { StorageConfig } from '@form/config';
import type { EgressGuard, Storage } from '@form/ports';
import { createFilesystemStorage } from './filesystem.ts';
import { createS3Storage } from './s3.ts';

export interface OpenStorageDeps {
  /** The infrastructure guard (`createInfrastructureEgressGuard`); the filesystem store makes no connection. */
  egress: EgressGuard;
  /** The development store only: where its presigned URLs point, and their key. */
  filesystem?: { publicUrl: string; signingKey: Uint8Array };
  readFile?: (path: string) => Promise<string>;
}

/** The store of `STORAGE_DRIVER` (architecture §1.5, §6, ADR-0018). */
export async function openStorage(c: StorageConfig, deps: OpenStorageDeps): Promise<Storage> {
  if (c.driver === 'filesystem') {
    if (!deps.filesystem) throw new Error('the filesystem store needs its development endpoint');
    return createFilesystemStorage({ root: c.root, ...deps.filesystem });
  }
  const read = deps.readFile ?? ((p: string) => readFile(p, 'utf8'));
  return createS3Storage({
    region: c.region,
    endpoint: c.endpoint,
    forcePathStyle: c.forcePathStyle,
    publicEndpoint: c.publicEndpoint,
    credentials: c.credentials ? { accessKeyId: c.credentials.accessKeyId, secretAccessKey: (await read(c.credentials.secretAccessKeyFile)).trim() } : undefined,
    buckets: c.buckets,
    sse: c.sse,
    egress: deps.egress,
  });
}
