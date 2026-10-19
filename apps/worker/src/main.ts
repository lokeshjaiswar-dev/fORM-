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

const [
  { createDb },
  { createFilesystemStorage, createPgBossQueue, createSyslogAuditSink, loadKeyfileKeyProvider, parseJobKeyring },
  { jobGuard },
  { startWorker },
  { onShutdownSignal },
  { createAuditJobs, JOB_DEFINITIONS },
  { startAuditChainDispatcher },
  { randomBytes },
] = await Promise.all([
  import('@form/db'),
  import('@form/adapters'),
  import('./guard.ts'),
  import('./runtime.ts'),
  import('./signals.ts'),
  import('./jobs/index.ts'),
  import('./audit/dispatcher.ts'),
  import('node:crypto'),
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
// Denied and failed audit records get their own small pool, so a saturated main pool cannot hold them up (BL-036).
const auditHandle = createDb(config.database.url, {
  max: config.audit.poolMax,
  applicationName: 'fr-worker-audit',
  connectionTimeoutMs: 5000,
  onError: (err) => log.error({ err }, 'idle audit database connection failed'),
});

let keys;
try {
  keys = config.audit.kms.keyfilePath ? await loadKeyfileKeyProvider(config.audit.kms.keyfilePath) : undefined;
} catch (err) {
  log.fatal({ err }, 'KMS_KEYFILE_PATH is unreadable or invalid');
  process.exit(1);
}
if (!keys) log.warn('KMS_KEYFILE_PATH is not set: audit.checkpoint, audit.verify and audit.archive are not served (development only)');
const storage = config.storage
  ? createFilesystemStorage({ root: config.storage.root, publicUrl: 'http://127.0.0.1/_dev/storage', signingKey: randomBytes(32) })
  : undefined;
const sink = config.audit.syslog ? createSyslogAuditSink({ url: config.audit.syslog.url, ca: config.audit.syslog.ca }) : undefined;
const jobs = [
  ...JOB_DEFINITIONS,
  ...(keys
    ? createAuditJobs({
        keys,
        signingKeyId: config.audit.signingKeyId,
        retiredSigningKeyIds: config.audit.retiredSigningKeyIds,
        storage,
        sink,
        requireAnchor: config.audit.requireAnchor,
        auditWriter: auditHandle.db,
        retentionYears: config.audit.retentionYears,
      })
    : []),
];

const queue = createPgBossQueue({
  connectionString: config.queue.url,
  keyring,
  mode: 'worker',
  applicationName: 'fr-worker',
  pollingIntervalSeconds: config.queue.pollIntervalMs / 1000,
  ...jobGuard(handle.db, log, auditHandle.db),
  onError: (err) => log.error({ err }, 'queue error'),
});
if (!config.queue.sharesDatabase) log.warn('QUEUE_DATABASE_URL is set: producers cannot enqueue inside their business transactions');

let dispatcher: { stop(): Promise<void> } | undefined;
onShutdownSignal(
  async (signal) => {
    log.info({ signal, graceMs: config.shutdownGraceMs }, 'shutting down');
    await dispatcher?.stop();
    await queue.stop({ graceMs: config.shutdownGraceMs });
    await handle.close();
    await auditHandle.close();
    await telemetry?.shutdown();
    log.info('stopped');
  },
  { onError: (err) => log.error({ err }, 'shutdown failed') },
);

await queue.start();
const started = await startWorker({ db: handle.db, log, queue, jobs, queues: config.queues, seedTemplates: config.seedTemplates });
if (started.queues.includes('audit.chain')) {
  dispatcher = startAuditChainDispatcher({ db: handle.db, queue, log, intervalMs: config.audit.dispatchIntervalMs });
}
