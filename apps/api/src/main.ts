import { randomBytes } from 'node:crypto';
import { createInfrastructureEgressGuard, infrastructureHosts } from '@form/adapters/egress';
import { createKeyfileKeyProvider, openKeyProvider } from '@form/adapters/kms';
import { createSmtpMailer, MAILPIT_SMTP_URL } from '@form/adapters/mailer';
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

const { buildApp } = await import('./app.ts');
const app = await buildApp(config, { keys, ...(mailer ? { mailer } : {}) });
for (const notice of config.edition.notices) app.log.warn({ notice }, 'edition notice');
for (const notice of config.notices) app.log.warn({ notice }, 'config notice');
if (devKeys) app.log.warn('KMS_KEYFILE_PATH is not set: TOTP secrets use a key that ends with this process (development only)');

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await telemetry?.shutdown();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
