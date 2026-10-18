import { checkClock, startTelemetry } from '@form/observability';
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

const { buildApp } = await import('./app.ts');
const app = await buildApp(config);
for (const notice of config.edition.notices) app.log.warn({ notice }, 'edition notice');

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
