import { readFileSync } from 'node:fs';
import { parseEditionConfig, parseKmsConfig, parseStorageConfig, type EditionConfig, type KmsConfig, type StorageConfig } from '@form/config';
import { LOG_LEVELS, type LogLevel } from '@form/observability';
import { z } from 'zod';

export const NODE_ENVS = ['development', 'test', 'production'] as const;

const flag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const list = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0),
);
const postgresUrl = (role: string) => z.string().regex(/^postgres(ql)?:\/\//, `expected a postgres:// URL for the ${role} role`);
/** A queue name, or a prefix ending in `.*` (`pdf.*`), as in `server worker --queues=pdf.*,templates.thumbnail`. */
const QUEUE_PATTERN = /^[a-z][a-z_]*(\.[a-z_]+)*(\.\*)?$/;

const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const headerList = z.string().transform((s, ctx) => {
  const out: Record<string, string> = {};
  for (const pair of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i <= 0) {
      ctx.addIssue({ code: 'custom', message: 'expected name=value pairs, comma-separated' });
      return z.NEVER;
    }
    out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
});

/** Worker process settings (architecture §1.5, §5). The edition, KMS and storage keys are parsed by @form/config. */
export const workerEnvSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVS).default('production'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    DATABASE_URL: postgresUrl('fr_app'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(10),
    /** Optional separate pg-boss database (§7.3). Without it the queue shares DATABASE_URL, which the outbox needs. */
    QUEUE_DATABASE_URL: postgresUrl('fr_app').optional(),
    /** `id:base64url` entries, the first signs (ADR-0016); parsed by the queue adapter at boot. */
    JOB_SIGNING_KEYS: z.string().min(1),
    /** Queues this process works; default all with a handler. */
    WORKER_QUEUES: list
      .pipe(z.array(z.string().regex(QUEUE_PATTERN, 'expected queue names or prefixes like pdf.*')).min(1))
      .optional(),
    /** SIGTERM: how long running jobs may finish before they are failed back to the queue (keep under the pod's grace period). */
    WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1000).max(600_000).default(25_000),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2000),
    /** Enqueue `templates.seed` at boot (architecture §7.3: seeding runs in the worker). */
    TEMPLATES_SEED_SYSTEM_PACKS: flag.default(true),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    OTEL_SERVICE_NAME: z.string().min(1).default('fr-worker'),
    OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(0.1),
    NTP_SERVERS: list.optional(),
    NTP_MAX_OFFSET_MS: z.coerce.number().int().min(1).default(1000),
    /** The small separate pool for denied and failed audit records (ADR-0006, BL-036). */
    AUDIT_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(2),
    /** How often the audit.chain dispatcher lists chains with pending rows. */
    AUDIT_CHAIN_POLL_MS: z.coerce.number().int().min(100).max(10_000).default(250),
    AUDIT_SIGNING_KEY_ID: z.string().regex(KEY_ID, 'expected a key id of [A-Za-z0-9._:-]').default('audit-v1'),
    /** Earlier audit signing keys whose checkpoints still verify after a rotation. */
    AUDIT_RETIRED_SIGNING_KEY_IDS: list.pipe(z.array(z.string().regex(KEY_ID, 'expected key ids of [A-Za-z0-9._:-]'))).optional(),
    /** Checkpoint fallback when the audit bucket has no Object Lock: the customer's syslog/SIEM. */
    AUDIT_SYSLOG_URL: z.string().regex(/^(tcp|tls):\/\/[^/]+:\d+$/, 'expected tcp://host:port or tls://host:port').optional(),
    AUDIT_SYSLOG_CA_FILE: z.string().min(1).optional(),
    /** Checkpoint fallback through an OpenTelemetry Collector (OTLP/HTTP logs), instead of syslog. */
    AUDIT_OTLP_URL: z.url().optional(),
    /** `name=value` headers for the collector, e.g. an API key; a secret, so usually `AUDIT_OTLP_HEADERS_FILE`. */
    AUDIT_OTLP_HEADERS: headerList.optional(),
    AUDIT_RETENTION_YEARS: z.coerce.number().int().min(1).max(30).default(7),
  })
  .superRefine((env, ctx) => {
    if (env.AUDIT_SYSLOG_URL && env.AUDIT_OTLP_URL) ctx.addIssue({ code: 'custom', path: ['AUDIT_OTLP_URL'], message: 'set AUDIT_SYSLOG_URL or AUDIT_OTLP_URL, not both' });
  });

export interface WorkerConfig {
  env: (typeof NODE_ENVS)[number];
  logLevel: LogLevel;
  database: { url: string; poolMax: number };
  queue: { url: string; sharesDatabase: boolean; signingKeys: string; pollIntervalMs: number };
  queues: string[] | undefined;
  shutdownGraceMs: number;
  seedTemplates: boolean;
  telemetry: { endpoint: string | undefined; serviceName: string; sampleRatio: number };
  ntp: { servers: string[]; maxOffsetMs: number };
  /** EGRESS_POLICY and its allowlist hold every outbound connection (KMS, store, SIEM). */
  edition: EditionConfig;
  kms: KmsConfig;
  audit: {
    poolMax: number;
    dispatchIntervalMs: number;
    signingKeyId: string;
    retiredSigningKeyIds: string[];
    syslog: { url: string; ca: string | undefined } | undefined;
    otlp: { url: string; headers: Record<string, string> } | undefined;
    retentionYears: number;
    /** Production refuses a checkpoint it cannot anchor in a WORM bucket or a SIEM. */
    requireAnchor: boolean;
  };
  /** The `audit` bucket (checkpoints when it has Object Lock, and archives). */
  storage: StorageConfig | undefined;
}

export type ConfigResult = { ok: true; config: WorkerConfig } | { ok: false; errors: string[] };

type Env = Record<string, string | undefined>;

const FILE_KEYS = ['DATABASE_URL', 'QUEUE_DATABASE_URL', 'JOB_SIGNING_KEYS', 'AUDIT_OTLP_HEADERS'];

/** Parses everything and reports every problem at once; `*_FILE` secrets win over plain variables. */
export function parseConfig(rawEnv: Env, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): ConfigResult {
  const env: Env = {};
  const errors: string[] = [];
  for (const [k, v] of Object.entries(rawEnv)) if (v !== undefined && v !== '') env[k] = v;
  for (const key of FILE_KEYS) {
    const file = env[`${key}_FILE`];
    if (!file) continue;
    try {
      env[key] = read(file).trim();
    } catch (err) {
      errors.push(`${key}_FILE: cannot read ${file} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  let syslogCa: string | undefined;
  if (env.AUDIT_SYSLOG_CA_FILE) {
    try {
      syslogCa = read(env.AUDIT_SYSLOG_CA_FILE);
    } catch (err) {
      errors.push(`AUDIT_SYSLOG_CA_FILE: cannot read ${env.AUDIT_SYSLOG_CA_FILE} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const parsed = workerEnvSchema.safeParse(env);
  const edition = parseEditionConfig(env);
  const kms = parseKmsConfig(env);
  const storage = parseStorageConfig(env);
  if (!parsed.success) errors.push(...parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  for (const r of [edition, kms, storage]) if (!r.ok) errors.push(...r.errors);
  // Cross-checks run on whatever parsed, so every problem is reported at once.
  if ((env.NODE_ENV ?? 'production') === 'production') {
    if (kms.ok && kms.config.driver === 'keyfile' && !kms.config.keyfilePath) errors.push('KMS_KEYFILE_PATH: is required in production: audit checkpoints are signed');
    if (env.STORAGE_DRIVER === 'filesystem') errors.push('STORAGE_DRIVER: filesystem is for development only');
    // A checkpoint needs an anchor: the S3 audit bucket (its Object Lock is checked at boot) or a SIEM.
    if (!env.AUDIT_SYSLOG_URL && !env.AUDIT_OTLP_URL && env.STORAGE_DRIVER !== 's3') {
      errors.push('AUDIT_SYSLOG_URL: is required in production without an S3 audit bucket (or AUDIT_OTLP_URL): checkpoints need an anchor');
    }
  }
  if (!parsed.success || !edition.ok || !kms.ok || !storage.ok || errors.length > 0) return { ok: false, errors };
  const e = parsed.data;
  return {
    ok: true,
    config: {
      env: e.NODE_ENV,
      logLevel: e.LOG_LEVEL,
      database: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX },
      queue: {
        url: e.QUEUE_DATABASE_URL ?? e.DATABASE_URL,
        sharesDatabase: e.QUEUE_DATABASE_URL === undefined,
        signingKeys: e.JOB_SIGNING_KEYS,
        pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
      },
      queues: e.WORKER_QUEUES,
      shutdownGraceMs: e.WORKER_SHUTDOWN_GRACE_MS,
      seedTemplates: e.TEMPLATES_SEED_SYSTEM_PACKS,
      telemetry: { endpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT, serviceName: e.OTEL_SERVICE_NAME, sampleRatio: e.OTEL_TRACES_SAMPLER_ARG },
      ntp: { servers: e.NTP_SERVERS ?? [], maxOffsetMs: e.NTP_MAX_OFFSET_MS },
      edition: edition.config,
      kms: kms.config,
      audit: {
        poolMax: e.AUDIT_DATABASE_POOL_MAX,
        dispatchIntervalMs: e.AUDIT_CHAIN_POLL_MS,
        signingKeyId: e.AUDIT_SIGNING_KEY_ID,
        retiredSigningKeyIds: e.AUDIT_RETIRED_SIGNING_KEY_IDS ?? [],
        syslog: e.AUDIT_SYSLOG_URL ? { url: e.AUDIT_SYSLOG_URL, ca: syslogCa } : undefined,
        otlp: e.AUDIT_OTLP_URL ? { url: e.AUDIT_OTLP_URL, headers: e.AUDIT_OTLP_HEADERS ?? {} } : undefined,
        retentionYears: e.AUDIT_RETENTION_YEARS,
        requireAnchor: e.NODE_ENV === 'production',
      },
      storage: storage.config,
    },
  };
}
