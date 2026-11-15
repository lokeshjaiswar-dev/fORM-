import { randomBytes } from 'node:crypto';
import { createInfrastructureEgressGuard, infrastructureHosts } from '@form/adapters/egress';
import { createKeyfileKeyProvider, openKeyProvider } from '@form/adapters/kms';
import { createSmtpMailer, MAILPIT_SMTP_URL } from '@form/adapters/mailer';
import { createPostgresSearchIndex } from '@form/adapters/search';
import type { PgBossQueue } from '@form/adapters/queue';
import { checkClock, startTelemetry } from '@form/observability';
import type { KeyProvider } from '@form/ports';
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

// The KMS and the SMTP relay are operator configuration: trusted endpoints of the EGRESS_POLICY guard.
const smtpUrl = config.mailer.smtpUrl ?? MAILPIT_SMTP_URL;
const egress = createInfrastructureEgressGuard(config.edition, infrastructureHosts({ kms: config.kms, urls: config.mailer.driver === 'smtp' ? [smtpUrl] : [] }));

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

const { buildApp } = await import('./app.ts');
const app = await buildApp(config, { keys, searchIndex: createPostgresSearchIndex, ...(queue ? { queue } : {}), ...(mailer ? { mailer } : {}) });
queueLog = app.log;
for (const notice of config.edition.notices) app.log.warn({ notice }, 'edition notice');
for (const notice of config.notices) app.log.warn({ notice }, 'config notice');
if (devKeys) app.log.warn('KMS_KEYFILE_PATH is not set: TOTP secrets use a key that ends with this process (development only)');
if (!queue) app.log.warn('JOB_SIGNING_KEYS is not set: stored responses enqueue no submission.fanout job (development only)');

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  // After the app: a request still in flight sends its job on its own transaction, and the pool is only closed now.
  await queue?.stop({ graceMs: 5000 });
  await telemetry?.shutdown();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
