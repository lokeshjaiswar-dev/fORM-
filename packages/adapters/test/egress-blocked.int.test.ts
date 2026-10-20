import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEditionConfig, type StorageConfig } from '@form/config';
import { BUCKET_NAMES, type BucketName } from '@form/ports';
import {
  collectBytes,
  installEgressTripwire,
  mailpitInbox,
  startMailpit,
  startSeaweedFs,
  startVault,
  utf8,
  type EgressTripwire,
  type MailpitServer,
  type SeaweedFs,
  type Vault,
} from '@form/testkit';
import { createWormBucketAuditSink } from '../src/audit-sink/index.ts';
import { createInfrastructureEgressGuard, infrastructureHosts } from '../src/egress/index.ts';
import { openKeyProvider, openRootKey, sealSigningSeed } from '../src/kms/index.ts';
import { createSmtpMailer } from '../src/mailer/index.ts';
import { openStorage, type S3Storage } from '../src/storage/index.ts';

/**
 * WP-1.03 acceptance, the container half: an air-gapped install (`EGRESS_POLICY=none`) with Vault transit, an in-cluster
 * S3 store and the customer relay, opened from KMS_* and STORAGE_* config the way the composition roots do it. Every
 * connection and lookup stays on the loopback addresses the containers are published on.
 */
describe('egress-blocked run against Vault, S3 and SMTP containers', () => {
  let vault: Vault;
  let s3: SeaweedFs;
  let mailpit: MailpitServer;
  let wire: EgressTripwire;

  beforeAll(async () => {
    [vault, s3, mailpit] = await Promise.all([startVault(), startSeaweedFs(), startMailpit()]);
    await vault.transitKey('form-root');
    wire = installEgressTripwire();
  });
  afterAll(async () => {
    wire?.uninstall();
    await Promise.all([vault?.stop(), s3?.stop(), mailpit?.stop()]);
  });

  it('wraps keys, signs, stores objects under Object Lock and sends mail, all on the internal network', async () => {
    const edition = loadEditionConfig({ DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none' });
    const prefix = `fr${randomBytes(4).toString('hex')}`;
    const storageConfig: StorageConfig = {
      driver: 's3',
      region: 'us-east-1',
      endpoint: s3.endpoint,
      forcePathStyle: true,
      publicEndpoint: undefined,
      credentials: { accessKeyId: s3.accessKeyId, secretAccessKeyFile: '/run/secrets/s3' },
      buckets: Object.fromEntries(BUCKET_NAMES.map((b) => [b, `${prefix}-${b}`])) as Record<BucketName, string>,
      sse: undefined,
    };
    const kmsConfig = {
      driver: 'vault' as const,
      address: vault.address,
      mount: 'transit',
      key: 'form-root',
      auth: { kind: 'token' as const, tokenFile: '/run/secrets/vault' },
      caFile: undefined,
      namespace: undefined,
      signing: { mode: 'app' as const, seedFile: '/run/secrets/seed' },
    };
    const egress = createInfrastructureEgressGuard(edition, infrastructureHosts({ kms: kmsConfig, storage: storageConfig, urls: [mailpit.smtpUrl] }));
    const files: Record<string, string> = { '/run/secrets/s3': s3.secretAccessKey, '/run/secrets/vault': vault.token };
    const readFile = async (p: string) => files[p] ?? Promise.reject(new Error(`ENOENT ${p}`));
    files['/run/secrets/seed'] = await sealSigningSeed(await openRootKey(kmsConfig, { egress, readFile }));

    const kms = await openKeyProvider(kmsConfig, { egress, readFile });
    const org = { orgId: randomUUID() };
    const dek = randomBytes(32);
    const { wrapped, kekRef } = await kms.wrap(dek, org);
    expect(await kms.unwrap(wrapped, kekRef, org)).toEqual(new Uint8Array(dek));
    expect((await kms.sign('audit-v1', utf8('cp'))).alg).toBe('ed25519');

    const storage = (await openStorage(storageConfig, { egress, readFile })) as S3Storage;
    await storage.ensureBuckets({ objectLockAudit: true });
    await createWormBucketAuditSink({ storage }).forward({
      orgKey: org.orgId,
      seq: 1,
      hash: 'ab'.repeat(32),
      signedAt: '2026-10-19T10:00:00.000Z' as never,
      keyId: 'audit-v1',
      alg: 'ed25519',
      signature: 'c2ln',
    });
    expect(await collectBytes(await storage.get('audit', `checkpoints/${org.orgId}/${'1'.padStart(20, '0')}.json`))).not.toHaveLength(0);

    const mailer = createSmtpMailer({ url: mailpit.smtpUrl, egress });
    const { messageId } = await mailer.send({ from: { address: 'noreply@corp.local' }, to: [{ address: 'dpo@corp.local' }], subject: 'air-gapped', text: 'ok' });
    expect(await mailpitInbox(mailpit.apiUrl).find(messageId)).toBeDefined();

    expect(wire.connections.length).toBeGreaterThan(0);
    expect(wire.violations()).toEqual([]);
  });
});
