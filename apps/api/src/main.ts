import { randomBytes } from 'node:crypto';
import { createKeyfileKeyProvider, createSmtpMailer, loadKeyfileKeyProvider, MAILPIT_SMTP_URL } from '@form/adapters';
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

// TOTP secrets are wrapped by the KMS. Outside production a missing keyfile means a random key for this process:
// two-factor enrolments made now do not survive a restart.
let keys: KeyProvider;
try {
  keys = config.kms.keyfilePath ? await loadKeyfileKeyProvider(config.kms.keyfilePath) : createKeyfileKeyProvider({ masterKey: randomBytes(32) });
} catch (err) {
  process.stderr.write(`kms: KMS_KEYFILE_PATH is unreadable or invalid (${err instanceof Error ? err.message : String(err)})
`);
  process.exit(1);
}
const mailer = config.mailer.driver === 'smtp' ? createSmtpMailer({ url: config.mailer.smtpUrl ?? MAILPIT_SMTP_URL }) : undefined;

const { buildApp } = await import('./app.ts');
const app = await buildApp(config, { keys, ...(mailer ? { mailer } : {}) });
for (const notice of config.edition.notices) app.log.warn({ notice }, 'edition notice');
for (const notice of config.notices) app.log.warn({ notice }, 'config notice');
if (!config.kms.keyfilePath) app.log.warn('KMS_KEYFILE_PATH is not set: TOTP secrets use a key that ends with this process (development only)');

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
