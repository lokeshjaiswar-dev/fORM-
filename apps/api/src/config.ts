import { readFileSync } from 'node:fs';
import { parseEditionConfig, type EditionConfig } from '@form/config';
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

/** API process settings (architecture §1.5). The edition keys are parsed by @form/config. */
export const apiEnvSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVS).default('production'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(0).max(65535).default(8080),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'expected a postgres:// URL for the fr_app role'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
    /** CORS allows this origin only (architecture §3.1). */
    PUBLIC_BUILDER_URL: z.url().optional(),
    TRUST_PROXY: flag.default(false),
    /** OTLP/HTTP base URL. Unset means no telemetry leaves the process. */
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    OTEL_SERVICE_NAME: z.string().min(1).default('fr-api'),
    OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(0.1),
    /** Checked at boot and by /readyz; unset skips the check. */
    NTP_SERVERS: list.optional(),
    NTP_MAX_OFFSET_MS: z.coerce.number().int().min(1).default(1000),
    /** Dev-only header authentication until real sign-in (WP-1.01). */
    AUTH_DEV_HEADERS: flag.default(false),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_DEV_HEADERS && env.NODE_ENV === 'production') {
      ctx.addIssue({ code: 'custom', path: ['AUTH_DEV_HEADERS'], message: 'is refused when NODE_ENV=production' });
    }
  });

export interface ApiConfig {
  env: (typeof NODE_ENVS)[number];
  host: string;
  port: number;
  logLevel: LogLevel;
  database: { url: string; poolMax: number };
  corsOrigins: string[];
  trustProxy: boolean;
  telemetry: { endpoint: string | undefined; serviceName: string; sampleRatio: number };
  ntp: { servers: string[]; maxOffsetMs: number };
  authDevHeaders: boolean;
  edition: EditionConfig;
}

export type ConfigResult = { ok: true; config: ApiConfig } | { ok: false; errors: string[] };

type Env = Record<string, string | undefined>;

/** `*_FILE` secrets win over plain variables (architecture §1.5). */
function resolveFiles(env: Env, read: (path: string) => string): { env: Env; errors: string[] } {
  const out: Env = {};
  const errors: string[] = [];
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') out[k] = v;
  for (const key of ['DATABASE_URL']) {
    const file = out[`${key}_FILE`];
    if (!file) continue;
    try {
      out[key] = read(file).trim();
    } catch (err) {
      errors.push(`${key}_FILE: cannot read ${file} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { env: out, errors };
}

/** Parses everything and reports every problem at once; the process refuses to start on any error. */
export function parseConfig(rawEnv: Env, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): ConfigResult {
  const { env, errors } = resolveFiles(rawEnv, read);
  const api = apiEnvSchema.safeParse(env);
  const edition = parseEditionConfig(env);
  if (!api.success) errors.push(...api.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  if (!edition.ok) errors.push(...edition.errors);
  if (!api.success || !edition.ok || errors.length > 0) return { ok: false, errors };
  const e = api.data;
  return {
    ok: true,
    config: {
      env: e.NODE_ENV,
      host: e.HOST,
      port: e.PORT,
      logLevel: e.LOG_LEVEL,
      database: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX },
      corsOrigins: e.PUBLIC_BUILDER_URL ? [new URL(e.PUBLIC_BUILDER_URL).origin] : [],
      trustProxy: e.TRUST_PROXY,
      telemetry: { endpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT, serviceName: e.OTEL_SERVICE_NAME, sampleRatio: e.OTEL_TRACES_SAMPLER_ARG },
      ntp: { servers: e.NTP_SERVERS ?? [], maxOffsetMs: e.NTP_MAX_OFFSET_MS },
      authDevHeaders: e.AUTH_DEV_HEADERS,
      edition: edition.config,
    },
  };
}
