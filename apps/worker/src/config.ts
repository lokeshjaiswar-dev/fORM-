import { readFileSync } from 'node:fs';
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

/** Worker process settings (architecture §1.5, §5). */
export const workerEnvSchema = z.object({
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
}

export type ConfigResult = { ok: true; config: WorkerConfig } | { ok: false; errors: string[] };

type Env = Record<string, string | undefined>;

const FILE_KEYS = ['DATABASE_URL', 'QUEUE_DATABASE_URL', 'JOB_SIGNING_KEYS'];

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
  const parsed = workerEnvSchema.safeParse(env);
  if (!parsed.success) errors.push(...parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  if (!parsed.success || errors.length > 0) return { ok: false, errors };
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
    },
  };
}
