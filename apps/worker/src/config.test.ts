import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.ts';

const base = {
  DEPLOYMENT_MODE: 'onprem',
  DATABASE_URL: 'postgres://fr_app:pw@db:5432/form',
  JOB_SIGNING_KEYS: 'k1:secret',
  KMS_KEYFILE_PATH: '/run/secrets/form-master.key',
  AUDIT_SYSLOG_URL: 'tcp://siem:514',
};

describe('parseConfig', () => {
  it('applies defaults; the queue shares the app database', () => {
    const r = parseConfig(base);
    expect(r.ok && r.config).toEqual({
      env: 'production',
      logLevel: 'info',
      database: { url: base.DATABASE_URL, poolMax: 10 },
      queue: { url: base.DATABASE_URL, sharesDatabase: true, signingKeys: 'k1:secret', pollIntervalMs: 2000 },
      queues: undefined,
      shutdownGraceMs: 25_000,
      seedTemplates: true,
      telemetry: { endpoint: undefined, serviceName: 'fr-worker', sampleRatio: 0.1 },
      ntp: { servers: [], maxOffsetMs: 1000 },
      edition: expect.objectContaining({ deploymentMode: 'onprem', egressPolicy: 'allowlist', egressAllowlist: [] }),
      kms: { driver: 'keyfile', keyfilePath: '/run/secrets/form-master.key' },
      audit: {
        poolMax: 2,
        dispatchIntervalMs: 250,
        signingKeyId: 'audit-v1',
        retiredSigningKeyIds: [],
        syslog: { url: 'tcp://siem:514', ca: undefined },
        otlp: undefined,
        retentionYears: 7,
        requireAnchor: true,
      },
      storage: undefined,
    });
  });

  it('configures audit anchoring: the SIEM sink with its CA, and the development store', () => {
    const r = parseConfig(
      { ...base, NODE_ENV: 'development', AUDIT_SYSLOG_URL: 'tls://siem.corp.local:6514', AUDIT_SYSLOG_CA_FILE: '/ca.pem', STORAGE_DRIVER: 'filesystem', STORAGE_ROOT: '.data' },
      () => 'PEM',
    );
    expect(r.ok && r.config).toMatchObject({
      audit: { syslog: { url: 'tls://siem.corp.local:6514', ca: 'PEM' }, requireAnchor: false },
      storage: { driver: 'filesystem', root: '.data' },
    });
  });

  it('refuses production without a signing key or with the development store', () => {
    const r = parseConfig({ DEPLOYMENT_MODE: 'onprem', DATABASE_URL: base.DATABASE_URL, JOB_SIGNING_KEYS: 'k1:secret', STORAGE_DRIVER: 'filesystem', AUDIT_SYSLOG_URL: 'udp://x:514' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const all = r.errors.join('\n');
    expect(all).toMatch(/KMS_KEYFILE_PATH: is required in production/);
    expect(all).toMatch(/STORAGE_DRIVER: filesystem is for development only/);
    expect(all).toMatch(/STORAGE_ROOT/);
    expect(all).toMatch(/AUDIT_SYSLOG_URL/);
  });

  it('reads queue selection, a separate queue database and secrets from files', () => {
    const files: Record<string, string> = { '/run/secrets/db': 'postgres://fr_app:file@db/form\n', '/run/secrets/keys': 'k2:abc\n' };
    const r = parseConfig(
      {
        DEPLOYMENT_MODE: 'saas',
        DATABASE_URL_FILE: '/run/secrets/db',
        JOB_SIGNING_KEYS_FILE: '/run/secrets/keys',
        JOB_SIGNING_KEYS: 'ignored:x',
        QUEUE_DATABASE_URL: 'postgresql://fr_app:pw@queue/jobs',
        WORKER_QUEUES: 'pdf.*, templates.thumbnail',
        WORKER_SHUTDOWN_GRACE_MS: '5000',
        TEMPLATES_SEED_SYSTEM_PACKS: 'false',
        KMS_KEYFILE_PATH: '/run/secrets/form-master.key',
        AUDIT_SYSLOG_URL: 'tls://siem:6514',
        AUDIT_RETIRED_SIGNING_KEY_IDS: 'audit-v0, audit-old',
      },
      (p) => files[p]!,
    );
    expect(r.ok && r.config).toMatchObject({
      database: { url: 'postgres://fr_app:file@db/form' },
      queue: { url: 'postgresql://fr_app:pw@queue/jobs', sharesDatabase: false, signingKeys: 'k2:abc' },
      queues: ['pdf.*', 'templates.thumbnail'],
      shutdownGraceMs: 5000,
      seedTemplates: false,
      audit: { retiredSigningKeyIds: ['audit-v0', 'audit-old'] },
    });
  });

  it('reports every error at once', () => {
    const r = parseConfig(
      { DATABASE_URL: 'mysql://x', WORKER_QUEUES: 'Bad Queue', WORKER_SHUTDOWN_GRACE_MS: '10', JOB_SIGNING_KEYS_FILE: '/missing' },
      () => {
        throw new Error('ENOENT');
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const all = r.errors.join('\n');
    expect(all).toMatch(/JOB_SIGNING_KEYS_FILE: cannot read \/missing \(ENOENT\)/);
    expect(all).toMatch(/DATABASE_URL: expected a postgres/);
    expect(all).toMatch(/WORKER_QUEUES/);
    expect(all).toMatch(/WORKER_SHUTDOWN_GRACE_MS/);
  });

  it('refuses production with no checkpoint anchor', () => {
    const { AUDIT_SYSLOG_URL: _, ...noSink } = base;
    const r = parseConfig(noSink);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual([expect.stringMatching(/^AUDIT_SYSLOG_URL: is required in production/)]);
    expect(parseConfig({ ...noSink, NODE_ENV: 'development' }).ok).toBe(true);
  });

  it('requires signing keys and the edition', () => {
    const r = parseConfig({ DATABASE_URL: base.DATABASE_URL });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/JOB_SIGNING_KEYS[\s\S]*DEPLOYMENT_MODE/);
  });

  it('wires a cloud KMS, the S3 audit bucket and an OTLP collector', () => {
    const { AUDIT_SYSLOG_URL: _, KMS_KEYFILE_PATH: __, ...rest } = base;
    const r = parseConfig(
      {
        ...rest,
        DEPLOYMENT_MODE: 'saas',
        KMS_DRIVER: 'aws',
        AWS_REGION: 'ap-south-1',
        KMS_KEY_ID: 'alias/form-root',
        KMS_SIGNING_SEED_FILE: '/run/secrets/signing-seed',
        STORAGE_DRIVER: 's3',
        STORAGE_BUCKET_AUDIT: 'acme-audit',
        AUDIT_OTLP_URL: 'https://otel.acme.example:4318',
        AUDIT_OTLP_HEADERS_FILE: '/run/secrets/otlp',
      },
      () => 'x-api-key=k1, x-tenant=acme',
    );
    expect(r.ok && r.config).toMatchObject({
      kms: { driver: 'aws', region: 'ap-south-1', keyId: 'alias/form-root', signing: { mode: 'app', seedFile: '/run/secrets/signing-seed' } },
      storage: { driver: 's3', region: 'ap-south-1', buckets: { audit: 'acme-audit', uploads: 'fr-uploads' }, forcePathStyle: false },
      audit: { otlp: { url: 'https://otel.acme.example:4318', headers: { 'x-api-key': 'k1', 'x-tenant': 'acme' } }, syslog: undefined, requireAnchor: true },
    });
  });

  it('refuses a cloud KMS without its settings, and two SIEM sinks at once', () => {
    const r = parseConfig({ ...base, KMS_DRIVER: 'vault', AUDIT_OTLP_URL: 'http://otel:4318' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const all = r.errors.join('\n');
    expect(all).toMatch(/KMS_VAULT_ADDR: is required/);
    expect(all).toMatch(/KMS_KEY_ID: is required with KMS_DRIVER=vault/);
    expect(all).toMatch(/KMS_SIGNING_SEED_FILE: is required/);
    expect(all).toMatch(/AUDIT_OTLP_URL: set AUDIT_SYSLOG_URL or AUDIT_OTLP_URL, not both/);
  });
});
