import { randomBytes } from 'node:crypto';
import { createInfrastructureEgressGuard, createTenantEgressGuard, egressHttp, infrastructureHosts } from '@form/adapters/egress';
import { createKeyfileKeyProvider, createOrgSecrets, openKeyProvider } from '@form/adapters/kms';
import { createSmtpMailer, MAILPIT_SMTP_URL } from '@form/adapters/mailer';
import { createPostgresSearchIndex } from '@form/adapters/search';
import type { PgBossQueue } from '@form/adapters/queue';
import { checkClock, startTelemetry } from '@form/observability';
import type { KeyProvider, Storage } from '@form/ports';
import { parseConfig } from './config.ts';

// Composition root. Telemetry must start before fastify and pg are imported, so the app is loaded dynamically.
const parsed = parseConfig(process.env);
if (!parsed.ok) {
  for (const e of parsed.errors) process.stderr.write(`config: ${e}\n`);
  process.exit(1);
}
const config = parsed.config;

const telemetry = await startTelemetry({
  endpoint: config.telemetry.endpoint,
  serviceName: config.telemetry.serviceName,
  sampleRatio: config.telemetry.sampleRatio,
});

const clock = await checkClock({ servers: config.ntp.servers, maxOffsetMs: config.ntp.maxOffsetMs });
if (clock.status === 'failed') {
  process.stderr.write(`clock: ${clock.reason}; refusing to start (TOTP, retention and audit ordering depend on it)\n`);
  process.exit(1);
}

// The KMS, the object store and the SMTP relay are operator configuration: trusted endpoints of the EGRESS_POLICY guard.
const smtpUrl = config.mailer.smtpUrl ?? MAILPIT_SMTP_URL;
const egress = createInfrastructureEgressGuard(
  config.edition,
  infrastructureHosts({ kms: config.kms, storage: config.storage, urls: config.mailer.driver === 'smtp' ? [smtpUrl] : [] }),
);
// Destinations a tenant supplies (a webhook URL, an org's own SMTP relay) get no trusted hosts: EGRESS_POLICY and EGRESS_ALLOWLIST only.
const tenantEgress = createTenantEgressGuard(config.edition);

// TOTP secrets are wrapped by the KMS. Outside production a missing keyfile means a random key for this process:
// two-factor enrolments made now do not survive a restart.
const devKeys = config.kms.driver === 'keyfile' && !config.kms.keyfilePath;
let keys: KeyProvider;
try {
  keys = devKeys ? createKeyfileKeyProvider({ masterKey: randomBytes(32) }) : await openKeyProvider(config.kms, { egress });
} catch (err) {
  process.stderr.write(`kms: the ${config.kms.driver} KMS is unreachable or misconfigured (${err instanceof Error ? err.message : String(err)})
`);
  process.exit(1);
}
const mailer = config.mailer.driver === 'smtp' ? createSmtpMailer({ url: smtpUrl, egress }) : undefined;
// The secrets of an org (an email sender's SMTP URL, a webhook's signing key) are sealed and opened under that org's key
// context. Routes get this port and never import the adapter, which only this file may do.
const orgSecrets = createOrgSecrets(keys);

// The producer queue: every stored response sends one `submission.fanout` job through the submit transaction (the
// transactional outbox), so it runs on the API's own database, never on QUEUE_DATABASE_URL. pg-boss loads pg, so it is
// imported here, after telemetry has started. Production refuses to run without it: an API that stores responses and
// cannot enqueue their fan-out would drop notifications silently.
let queue: PgBossQueue | undefined;
let queueLog: { error(fields: object, message: string): void } | undefined;
if (config.jobSigningKeys) {
  try {
    const { createPgBossQueue, parseJobKeyring } = await import('@form/adapters/queue');
    queue = createPgBossQueue({
      connectionString: config.database.url,
      keyring: parseJobKeyring(config.jobSigningKeys),
      mode: 'producer',
      applicationName: 'fr-api-queue',
      // Sends run on the submit transaction; this pool only reads the queue's settings and checks its schema.
      max: 2,
      onError: (err) => (queueLog ? queueLog.error({ err }, 'queue error') : process.stderr.write(`queue: ${err.message}\n`)),
    });
    await queue.start();
  } catch (err) {
    process.stderr.write(`queue: JOB_SIGNING_KEYS is invalid or the pg-boss schema is not installed (${err instanceof Error ? err.message : String(err)})\n`);
    process.exit(1);
  }
} else if (config.env === 'production') {
  process.stderr.write('config: JOB_SIGNING_KEYS is required in production: every stored response sends a signed submission.fanout job\n');
  process.exit(1);
}

// The object store of exports (WP-1.17): the worker writes the finished file, the API streams it after the auth check. Like the
// worker it is opened here, after telemetry started, and only when STORAGE_DRIVER is set; without it the export routes answer 503.
let storage: Storage | undefined;
if (config.storage) {
  try {
    const { openStorage } = await import('@form/adapters/storage');
    // The API only streams (it never signs a URL), so the development store's presign key can be this process's own.
    storage = await openStorage(config.storage, { egress, filesystem: { publicUrl: 'http://127.0.0.1/_dev/storage', signingKey: randomBytes(32) } });
  } catch (err) {
    process.stderr.write(`storage: the ${config.storage.driver} object store is misconfigured (${err instanceof Error ? err.message : String(err)})\n`);
    process.exit(1);
  }
}

// The request pool is made here, not by buildApp, because the org mailer reads a sealed secret on it (as a system context of
// one org) and is built before the app. Like the queue, it is closed after the app on shutdown.
// Both modules load pg, so they are imported here, after telemetry has started.
const [{ createDb }, { createOrgMailer }] = await Promise.all([import('@form/db'), import('./org-mailer.ts')]);
const db = createDb(config.database.url, {
  max: config.database.poolMax,
  applicationName: 'fr-api',
  onError: (err) => (queueLog ? queueLog.error({ err }, 'idle database connection failed') : process.stderr.write(`database: ${err.message}\n`)),
});
const orgMailer = createOrgMailer({
  db: db.db,
  orgSecrets,
  tenantEgress,
  // The platform relay for a message with no sender of the org, and the org's own relay (opened per message) behind the tenant guard.
  makeSmtpMailer: (senders) => createSmtpMailer({ url: smtpUrl, egress, senders }),
});

const { buildApp } = await import('./app.ts');
const app = await buildApp(config, {
  db,
  keys,
  orgSecrets,
  tenantEgress,
  // Lookups, option lists and checks call an API the form's owner chose: through the tenant guard, pinned to the vetted address, no redirect.
  tenantHttp: (url, request) => egressHttp(tenantEgress, url, request),
  orgMailer,
  searchIndex: createPostgresSearchIndex,
  ...(storage ? { storage } : {}),
  ...(queue ? { queue } : {}),
  ...(mailer ? { mailer } : {}),
});
queueLog = app.log;
for (const notice of config.edition.notices) app.log.warn({ notice }, 'edition notice');
for (const notice of config.notices) app.log.warn({ notice }, 'config notice');
if (devKeys) app.log.warn('KMS_KEYFILE_PATH is not set: TOTP secrets and org secrets (SMTP credentials, webhook signing keys) use a key that ends with this process (development only)');
if (!queue) app.log.warn('JOB_SIGNING_KEYS is not set: stored responses enqueue no submission.fanout job (development only)');

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  // After the app: a request still in flight sends its job on its own transaction, and the pools are only closed now.
  await queue?.stop({ graceMs: 5000 });
  await db.close();
  await telemetry?.shutdown();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
