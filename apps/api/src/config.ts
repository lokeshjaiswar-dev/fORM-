import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { KMS_DRIVERS, parseEditionConfig, parseKmsConfig, type EditionConfig, type KmsConfig } from '@form/config';
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

const PROXY_NAMES = ['loopback', 'linklocal', 'uniquelocal'];
const proxyAddress = (v: string) => {
  const [addr = '', prefix, extra] = v.split('/');
  const family = isIP(addr);
  if (family === 0 || extra !== undefined) return PROXY_NAMES.includes(v);
  return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128));
};

/**
 * Which X-Forwarded-For hops to believe: `false`, the number of proxies in front of the API, or their addresses and
 * CIDRs. `true` would believe every hop, and the left-most one is the client's to choose (per-IP auth limits).
 */
const trustProxy = z
  .string()
  .trim()
  .default('false')
  .transform((v, ctx): false | number | string[] => {
    if (v === 'false' || v === '0') return false;
    if (/^\d{1,2}$/.test(v)) return Number(v);
    const list = v
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    if (v !== 'true' && list.length > 0 && list.every(proxyAddress)) return list;
    ctx.addIssue({
      code: 'custom',
      message: 'expected false, a hop count, or proxy addresses/CIDRs (loopback, linklocal, uniquelocal); true would trust a client-chosen X-Forwarded-For',
    });
    return z.NEVER;
  });

/** API process settings (architecture §1.5). The edition keys are parsed by @form/config. */
export const apiEnvSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVS).default('production'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(0).max(65535).default(8080),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'expected a postgres:// URL for the fr_app role'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
    /** The separate pool for denied and failed audit records, so a saturated main pool cannot hold them up. */
    DATABASE_AUDIT_POOL_MAX: z.coerce.number().int().min(1).max(20).default(2),
    /** CORS allows this origin only (architecture §3.1). */
    PUBLIC_BUILDER_URL: z.url().optional(),
    TRUST_PROXY: trustProxy,
    /** OTLP/HTTP base URL. Unset means no telemetry leaves the process. */
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    OTEL_SERVICE_NAME: z.string().min(1).default('fr-api'),
    OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(0.1),
    /** Checked at boot and by /readyz; unset skips the check. */
    NTP_SERVERS: list.optional(),
    NTP_MAX_OFFSET_MS: z.coerce.number().int().min(1).default(1000),
    /** Header authentication (`X-FR-Dev-User`) for tests and local development, next to sessions. */
    AUTH_DEV_HEADERS: flag.default(false),
    /** The API's own origin: OAuth redirect URIs (`<url>/v1/auth/oauth/<provider>/callback`). */
    PUBLIC_API_URL: z.url().optional(),
    /** At least 32 random bytes, base64url: the daily IP-hash salt, account throttle keys and the OAuth transaction cookie. */
    AUTH_SECRET: z
      .string()
      .refine((v) => /^[A-Za-z0-9_-]+$/.test(v) && Buffer.from(v, 'base64url').byteLength >= 32, { message: 'expected at least 32 bytes, base64url' })
      .optional(),
    /** `smtp` (Mailpit by default outside production) or `log` (recipient and subject only, never the link). */
    MAILER_DRIVER: z.enum(['smtp', 'log']).default('smtp'),
    SMTP_URL: z.string().regex(/^smtps?:\/\/[^/]+/, 'expected smtp://host:port or smtps://user:pass@host:port').optional(),
    MAIL_FROM: z.email().default('no-reply@form.local'),
    MAIL_FROM_NAME: z.string().min(1).max(100).default('fORM-'),
    /** Wraps the data keys of TOTP secrets; the other KMS_* keys are parsed by @form/config. */
    KMS_DRIVER: z.enum(KMS_DRIVERS).default('keyfile'),
    KMS_KEYFILE_PATH: z.string().min(1).optional(),
    /** Have I Been Pwned (k-anonymity) at sign-up and reset. Default: on for SaaS with EGRESS_POLICY=open. */
    PASSWORD_BREACH_CHECK: z.enum(['hibp', 'off']).optional(),
    /** The issuer authenticator apps show next to the account. */
    AUTH_TOTP_ISSUER: z.string().min(1).max(40).regex(/^[^:]+$/, 'must not contain a colon').default('fORM-'),
    OIDC_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    OIDC_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_GOOGLE_ISSUER: z.url().default('https://accounts.google.com'),
    OIDC_MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
    OIDC_MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_MICROSOFT_ISSUER: z.url().default('https://login.microsoftonline.com/common/v2.0'),
    /** Who is the Data Fiduciary for builder accounts (CMP-21): the SaaS operator, or the customer that runs the service on-prem. */
    PRIVACY_FIDUCIARY_NAME: z.string().trim().min(1).max(200).default('fORM-'),
    /** Where builder users send privacy requests and grievances; named in the platform privacy notice. */
    PRIVACY_CONTACT_EMAIL: z.email().optional(),
    /** The person or role who answers them, e.g. "Grievance Officer, Asha Rao". */
    PRIVACY_CONTACT_NAME: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    const production = env.NODE_ENV === 'production';
    if (env.AUTH_DEV_HEADERS && production) issue('AUTH_DEV_HEADERS', 'is refused when NODE_ENV=production');
    if (production && !env.AUTH_SECRET) issue('AUTH_SECRET', 'is required in production');
    if (production && env.KMS_DRIVER === 'keyfile' && !env.KMS_KEYFILE_PATH) issue('KMS_KEYFILE_PATH', 'is required in production: TOTP secrets are encrypted');
    if (production && !env.PUBLIC_BUILDER_URL) issue('PUBLIC_BUILDER_URL', 'is required in production: sign-in emails link to the builder');
    if (production && env.MAILER_DRIVER === 'smtp' && !env.SMTP_URL) issue('SMTP_URL', 'is required in production with MAILER_DRIVER=smtp');
    if (production && !env.PRIVACY_CONTACT_EMAIL) issue('PRIVACY_CONTACT_EMAIL', 'is required in production: the privacy notice names it as the contact for builder users');
    for (const p of ['GOOGLE', 'MICROSOFT'] as const) {
      if (!env[`OIDC_${p}_CLIENT_ID`] !== !env[`OIDC_${p}_CLIENT_SECRET`]) issue(`OIDC_${p}_CLIENT_SECRET`, `goes together with OIDC_${p}_CLIENT_ID`);
      if (production && new URL(env[`OIDC_${p}_ISSUER`]).protocol !== 'https:') issue(`OIDC_${p}_ISSUER`, 'must be https in production');
    }
  });

export interface ApiConfig {
  env: (typeof NODE_ENVS)[number];
  host: string;
  port: number;
  logLevel: LogLevel;
  database: { url: string; poolMax: number; auditPoolMax: number };
  corsOrigins: string[];
  /** Fastify `trustProxy`: never `true` (see TRUST_PROXY). */
  trustProxy: false | number | string[];
  telemetry: { endpoint: string | undefined; serviceName: string; sampleRatio: number };
  ntp: { servers: string[]; maxOffsetMs: number };
  authDevHeaders: boolean;
  auth: AuthConfig;
  mailer: { driver: 'smtp' | 'log'; smtpUrl: string | undefined; from: { address: string; name: string } };
  kms: KmsConfig;
  /** The platform's own privacy notice for builder users (CMP-21). */
  privacy: PrivacyConfig;
  edition: EditionConfig;
  /** Settings accepted but without effect here; logged at start. */
  notices: string[];
}

export interface PrivacyConfig {
  fiduciaryName: string;
  contactEmail: string;
  contactName: string | null;
}

export type OidcProviderName = 'google' | 'microsoft';

export interface OidcProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export interface AuthConfig {
  /** Unset outside production: random for this process (IP hashes and OAuth transactions do not survive a restart). */
  secret: Uint8Array;
  builderUrl: string;
  apiUrl: string;
  breachCheck: 'hibp' | 'off';
  totpIssuer: string;
  /** SaaS only (ADR-0017): empty on-prem, so always empty when air-gapped. */
  oidc: Partial<Record<OidcProviderName, OidcProviderConfig>>;
  /** Plain-http issuers (a local mock provider); never in production. */
  oidcAllowInsecure: boolean;
}

export type ConfigResult = { ok: true; config: ApiConfig } | { ok: false; errors: string[] };

type Env = Record<string, string | undefined>;

const FILE_KEYS = ['DATABASE_URL', 'AUTH_SECRET', 'SMTP_URL', 'OIDC_GOOGLE_CLIENT_SECRET', 'OIDC_MICROSOFT_CLIENT_SECRET'];

/** `*_FILE` secrets win over plain variables (architecture §1.5). */
function resolveFiles(env: Env, read: (path: string) => string): { env: Env; errors: string[] } {
  const out: Env = {};
  const errors: string[] = [];
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') out[k] = v;
  for (const key of FILE_KEYS) {
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
  const kms = parseKmsConfig(env);
  if (!api.success) errors.push(...api.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  if (!edition.ok) errors.push(...edition.errors);
  if (!kms.ok) errors.push(...kms.errors);
  if (!api.success || !edition.ok || !kms.ok || errors.length > 0) return { ok: false, errors };
  const e = api.data;
  const ed = edition.config;
  const notices: string[] = [];
  const oidc: AuthConfig['oidc'] = {};
  for (const [name, p] of [
    ['google', 'GOOGLE'],
    ['microsoft', 'MICROSOFT'],
  ] as const) {
    const clientId = e[`OIDC_${p}_CLIENT_ID`];
    const clientSecret = e[`OIDC_${p}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) continue;
    if (ed.deploymentMode !== 'saas') notices.push(`OIDC_${p}_* is ignored: Google and Microsoft sign-in are SaaS only (ADR-0017)`);
    else oidc[name] = { issuer: e[`OIDC_${p}_ISSUER`], clientId, clientSecret };
  }
  if (e.PASSWORD_BREACH_CHECK === 'hibp' && ed.egressPolicy === 'none') notices.push('PASSWORD_BREACH_CHECK=hibp is ignored when EGRESS_POLICY=none');
  const breachCheck = ed.egressPolicy === 'none' ? 'off' : (e.PASSWORD_BREACH_CHECK ?? (ed.deploymentMode === 'saas' && ed.egressPolicy === 'open' ? 'hibp' : 'off'));
  if (!e.AUTH_SECRET) notices.push('AUTH_SECRET is not set: a random secret is used for this process');
  return {
    ok: true,
    config: {
      env: e.NODE_ENV,
      host: e.HOST,
      port: e.PORT,
      logLevel: e.LOG_LEVEL,
      database: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX, auditPoolMax: e.DATABASE_AUDIT_POOL_MAX },
      corsOrigins: e.PUBLIC_BUILDER_URL ? [new URL(e.PUBLIC_BUILDER_URL).origin] : [],
      trustProxy: e.TRUST_PROXY,
      telemetry: { endpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT, serviceName: e.OTEL_SERVICE_NAME, sampleRatio: e.OTEL_TRACES_SAMPLER_ARG },
      ntp: { servers: e.NTP_SERVERS ?? [], maxOffsetMs: e.NTP_MAX_OFFSET_MS },
      authDevHeaders: e.AUTH_DEV_HEADERS,
      auth: {
        secret: new Uint8Array(e.AUTH_SECRET ? Buffer.from(e.AUTH_SECRET, 'base64url') : randomBytes(32)),
        builderUrl: (e.PUBLIC_BUILDER_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
        apiUrl: (e.PUBLIC_API_URL ?? `http://${e.HOST}:${e.PORT}`).replace(/\/+$/, ''),
        breachCheck,
        totpIssuer: e.AUTH_TOTP_ISSUER,
        oidc,
        oidcAllowInsecure: e.NODE_ENV !== 'production',
      },
      mailer: { driver: e.MAILER_DRIVER, smtpUrl: e.SMTP_URL, from: { address: e.MAIL_FROM, name: e.MAIL_FROM_NAME } },
      kms: kms.config,
      privacy: { fiduciaryName: e.PRIVACY_FIDUCIARY_NAME, contactEmail: e.PRIVACY_CONTACT_EMAIL ?? 'privacy@form.local', contactName: e.PRIVACY_CONTACT_NAME ?? null },
      edition: ed,
      notices,
    },
  };
}
