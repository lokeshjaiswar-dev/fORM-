import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.ts';

const base = { DATABASE_URL: 'postgres://fr_app:pw@db:5432/form', JOB_SIGNING_KEYS: 'k1:secret' };

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
    });
  });

  it('reads queue selection, a separate queue database and secrets from files', () => {
    const files: Record<string, string> = { '/run/secrets/db': 'postgres://fr_app:file@db/form\n', '/run/secrets/keys': 'k2:abc\n' };
    const r = parseConfig(
      {
        DATABASE_URL_FILE: '/run/secrets/db',
        JOB_SIGNING_KEYS_FILE: '/run/secrets/keys',
        JOB_SIGNING_KEYS: 'ignored:x',
        QUEUE_DATABASE_URL: 'postgresql://fr_app:pw@queue/jobs',
        WORKER_QUEUES: 'pdf.*, templates.thumbnail',
        WORKER_SHUTDOWN_GRACE_MS: '5000',
        TEMPLATES_SEED_SYSTEM_PACKS: 'false',
      },
      (p) => files[p]!,
    );
    expect(r.ok && r.config).toMatchObject({
      database: { url: 'postgres://fr_app:file@db/form' },
      queue: { url: 'postgresql://fr_app:pw@queue/jobs', sharesDatabase: false, signingKeys: 'k2:abc' },
      queues: ['pdf.*', 'templates.thumbnail'],
      shutdownGraceMs: 5000,
      seedTemplates: false,
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

  it('requires signing keys', () => {
    const r = parseConfig({ DATABASE_URL: base.DATABASE_URL });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/JOB_SIGNING_KEYS/);
  });
});
