import { checkClock, startTelemetry } from '@form/observability';
import { parseConfig } from './config.ts';
import type { EffectDeps } from './effects/deps.ts';

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
const { createServiceLogger } = await import('./log.ts');
const log = createServiceLogger({ level: config.logLevel, name: 'fr-worker', base: { service: config.telemetry.serviceName } });

const clock = await checkClock({ servers: config.ntp.servers, maxOffsetMs: config.ntp.maxOffsetMs });
if (clock.status === 'failed') {
  log.fatal({ reason: clock.reason }, 'clock check failed; refusing to start (retention, cron and audit ordering depend on it)');
  process.exit(1);
}

const [
  { createDb },
  { createPgBossQueue, parseJobKeyring },
  { createOrgSecrets, openKeyProvider },
  { createSmtpMailer, MAILPIT_SMTP_URL },
  { openStorage },
  { createOtlpAuditSink, createSyslogAuditSink, createWormBucketAuditSink },
  { createInfrastructureEgressGuard, createTenantEgressGuard, infrastructureHosts },
  { jobGuard },
  { startWorker },
  { onShutdownSignal },
  { createAuditJobs, createEffectFanout, createEffectJobs, createUploadJobs, JOB_DEFINITIONS },
  { createLogMailer, createMailerFor, unavailableOrgSecrets },
  { startAuditChainDispatcher },
  { createUploadStore },
  path,
  { randomBytes },
] = await Promise.all([
  import('@form/db'),
  import('@form/adapters/queue'),
  import('@form/adapters/kms'),
  import('@form/adapters/mailer'),
  import('@form/adapters/storage'),
  import('@form/adapters/audit-sink'),
  import('@form/adapters/egress'),
  import('./guard.ts'),
  import('./runtime.ts'),
  import('./signals.ts'),
  import('./jobs/index.ts'),
  import('./effects/deps.ts'),
  import('./audit/dispatcher.ts'),
  import('./file-store.ts'),
  import('node:path'),
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

// Every connection to the KMS, the store, the SIEM and the platform SMTP relay passes EGRESS_POLICY; the configured hosts are trusted endpoints.
const smtpUrl = config.mailer.smtpUrl ?? MAILPIT_SMTP_URL;
const egress = createInfrastructureEgressGuard(
  config.edition,
  infrastructureHosts({
    kms: config.kms,
    storage: config.storage,
    urls: [config.audit.syslog?.url, config.audit.otlp?.url, ...(config.mailer.driver === 'smtp' ? [smtpUrl] : [])],
  }),
);
// What a tenant chose (a webhook URL, an org's own SMTP server) gets no trusted hosts: EGRESS_POLICY and its allowlist only.
const tenantEgress = createTenantEgressGuard(config.edition);

let keys;
try {
  keys = config.kms.driver === 'keyfile' && !config.kms.keyfilePath ? undefined : await openKeyProvider(config.kms, { egress });
} catch (err) {
  log.fatal({ err, driver: config.kms.driver }, 'the KMS is unreachable or misconfigured');
  process.exit(1);
}
if (!keys) log.warn('KMS_KEYFILE_PATH is not set: audit.checkpoint, audit.verify and audit.archive are not served (development only)');
const storage = config.storage
  ? await openStorage(config.storage, { egress, filesystem: { publicUrl: 'http://127.0.0.1/_dev/storage', signingKey: randomBytes(32) } })
  : undefined;
const sink = config.audit.syslog
  ? createSyslogAuditSink({ url: config.audit.syslog.url, ca: config.audit.syslog.ca, egress })
  : config.audit.otlp
    ? createOtlpAuditSink({ url: config.audit.otlp.url, headers: config.audit.otlp.headers, egress, serviceName: config.telemetry.serviceName })
    : undefined;
const worm = storage ? createWormBucketAuditSink({ storage, retentionYears: config.audit.retentionYears }) : undefined;
// Production anchors every checkpoint: without a SIEM sink the audit bucket must really have Object Lock.
if (keys && config.audit.requireAnchor && !sink) {
  let locked = false;
  try {
    locked = (await worm?.available()) ?? false;
  } catch (err) {
    log.fatal({ err }, 'cannot read the capabilities of the audit bucket');
    process.exit(1);
  }
  if (!locked) {
    log.fatal('the audit bucket has no Object Lock and neither AUDIT_SYSLOG_URL nor AUDIT_OTLP_URL is set: checkpoints would have no anchor');
    process.exit(1);
  }
}

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

// The effect jobs (notifications, webhooks, exports) and the fan-out consumers that feed them. Org secrets (SMTP credentials,
// webhook keys) open only with a KMS; without one (development) every open fails as `unavailable` and a job retries.
const orgSecrets = keys ? createOrgSecrets(keys) : unavailableOrgSecrets;
if (!keys) log.warn('no KMS key provider: org secrets (org SMTP senders, webhook signing keys) cannot be opened, so those deliveries are retried until KMS_KEYFILE_PATH is set (development only)');
const platformMailer = config.mailer.driver === 'smtp' ? createSmtpMailer({ url: smtpUrl, egress, messageIdDomain: config.mailer.messageIdDomain }) : createLogMailer(log);
const effectDeps: EffectDeps = {
  db: handle.db,
  queue,
  orgSecrets,
  storage,
  mailerFor: createMailerFor({
    db: handle.db,
    orgSecrets,
    platform: platformMailer,
    // An org's own SMTP server is a tenant destination: it goes through the tenant guard and is read from the org's secret by id.
    makeOrgMailer: (senders) => createSmtpMailer({ url: smtpUrl, egress, senders: { resolve: senders.resolve, egress: tenantEgress }, messageIdDomain: config.mailer.messageIdDomain }),
  }),
  tenantEgress,
  config: {
    publicBuilderUrl: config.publicBuilderUrl,
    mailFrom: config.mailer.from,
    messageIdDomain: config.mailer.messageIdDomain,
    webhookUserAgent: 'fORM-Webhooks/1',
  },
  now: () => new Date(),
};
const jobs = [
  // The registry's consumerless submission.fanout is replaced by the one that feeds notifications and webhooks.
  ...JOB_DEFINITIONS.filter((d) => d.name !== 'submission.fanout'),
  createEffectFanout(effectDeps),
  ...createEffectJobs(effectDeps),
  // drafts.expire: the upload GC. It removes bytes where the API wrote them, so FILE_STORE_DIR must name the API's directory.
  ...createUploadJobs({ files: createUploadStore(config.filesDir ?? path.resolve(process.cwd(), '.data/files')) }),
  ...(keys
    ? createAuditJobs({
        keys,
        signingKeyId: config.audit.signingKeyId,
        retiredSigningKeyIds: config.audit.retiredSigningKeyIds,
        storage,
        worm,
        sink,
        requireAnchor: config.audit.requireAnchor,
        auditWriter: auditHandle.db,
        retentionYears: config.audit.retentionYears,
      })
    : []),
];

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
