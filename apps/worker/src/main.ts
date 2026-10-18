import { checkClock, createLogger, startTelemetry } from '@form/observability';
import { parseConfig } from './config.ts';

// Composition root. Telemetry must start before pg and pg-boss are imported, so the rest is loaded dynamically.
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
const log = createLogger({ level: config.logLevel, name: 'fr-worker', base: { service: config.telemetry.serviceName } });

const clock = await checkClock({ servers: config.ntp.servers, maxOffsetMs: config.ntp.maxOffsetMs });
if (clock.status === 'failed') {
  log.fatal({ reason: clock.reason }, 'clock check failed; refusing to start (retention, cron and audit ordering depend on it)');
  process.exit(1);
}

const [{ createDb }, { createPgBossQueue, parseJobKeyring }, { jobGuard }, { startWorker }, { onShutdownSignal }] = await Promise.all([
  import('@form/db'),
  import('@form/adapters'),
  import('./guard.ts'),
  import('./runtime.ts'),
  import('./signals.ts'),
]);

let keyring;
try {
  keyring = parseJobKeyring(config.queue.signingKeys);
} catch (err) {
  log.fatal({ err }, 'JOB_SIGNING_KEYS is invalid');
  process.exit(1);
}

const handle = createDb(config.database.url, {
  max: config.database.poolMax,
  applicationName: 'fr-worker',
  onError: (err) => log.error({ err }, 'idle database connection failed'),
});
const queue = createPgBossQueue({
  connectionString: config.queue.url,
  keyring,
  mode: 'worker',
  applicationName: 'fr-worker',
  pollingIntervalSeconds: config.queue.pollIntervalMs / 1000,
  ...jobGuard(handle.db, log),
  onError: (err) => log.error({ err }, 'queue error'),
});
if (!config.queue.sharesDatabase) log.warn('QUEUE_DATABASE_URL is set: producers cannot enqueue inside their business transactions');

onShutdownSignal(
  async (signal) => {
    log.info({ signal, graceMs: config.shutdownGraceMs }, 'shutting down');
    await queue.stop({ graceMs: config.shutdownGraceMs });
    await handle.close();
    await telemetry?.shutdown();
    log.info('stopped');
  },
  { onError: (err) => log.error({ err }, 'shutdown failed') },
);

await queue.start();
await startWorker({ db: handle.db, log, queue, queues: config.queues, seedTemplates: config.seedTemplates });
