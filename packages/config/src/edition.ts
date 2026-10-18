import { CAPTCHA_PROVIDERS, THIRD_PARTY_CAPTCHA_PROVIDERS, type ThirdPartyCaptchaProvider } from '@form/ports';
import { INTEGRATION_PROVIDERS, type FeatureId, type IntegrationProvider } from '@form/schema';
import { z } from 'zod';

export const DEPLOYMENT_MODES = ['saas', 'onprem'] as const;
export const EGRESS_POLICIES = ['open', 'allowlist', 'none'] as const;
export const PAYMENT_GATEWAYS = ['stripe', 'razorpay'] as const;
export const GUARDIAN_VERIFIER_DRIVERS = ['existing_account', 'manual_review', 'digilocker'] as const;
/** `form.analytics` providers (schema §1270); each loads a third-party script and needs egress. */
export const THIRD_PARTY_ANALYTICS = ['ga4', 'gtm', 'meta_pixel'] as const;

export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];
export type EgressPolicy = (typeof EGRESS_POLICIES)[number];
export type PaymentGateway = (typeof PAYMENT_GATEWAYS)[number];
export type GuardianVerifierDriver = (typeof GUARDIAN_VERIFIER_DRIVERS)[number];
export type ThirdPartyAnalytics = (typeof THIRD_PARTY_ANALYTICS)[number];
export { INTEGRATION_PROVIDERS };
export type { FeatureId, IntegrationProvider };

const HOST = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::(\d{1,5}))?$/;

function isHost(v: string): boolean {
  const m = HOST.exec(v);
  return m !== null && (m[1] === undefined || (Number(m[1]) >= 1 && Number(m[1]) <= 65535));
}

const splitList = (v: unknown) =>
  typeof v === 'string'
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : v;

/**
 * Comma-separated list. Items are checked with refinements, not enums or transforms, so a bad item
 * does not abort the cross-field checks and every error is reported at once.
 */
const list = (ok: (v: string) => boolean, message: string) => z.preprocess(splitList, z.array(z.string().refine(ok, { message })));
const oneOf = (values: readonly string[]) => list((v) => values.includes(v), `expected one of: ${values.join(', ')}`);

function only<T extends string>(values: readonly T[], xs: readonly string[] | undefined): T[] | undefined {
  return xs && [...new Set(xs)].filter((x): x is T => (values as readonly string[]).includes(x));
}

/** The edition keys of the environment (architecture §1.5). Empty strings count as unset. */
export const editionEnvSchema = z.object({
  DEPLOYMENT_MODE: z.enum(DEPLOYMENT_MODES),
  EGRESS_POLICY: z.enum(EGRESS_POLICIES).optional(),
  EGRESS_ALLOWLIST: list((v) => isHost(v.toLowerCase()), 'expected host or host:port (port 1-65535)').optional(),
  CAPTCHA_DEFAULT: z
    .string()
    .refine((v) => (CAPTCHA_PROVIDERS as readonly string[]).includes(v), { message: `expected one of: ${CAPTCHA_PROVIDERS.join(', ')}` })
    .optional(),
  /** Third-party providers forms may opt in to; proof of work is always available. */
  CAPTCHA_PROVIDERS: oneOf(THIRD_PARTY_CAPTCHA_PROVIDERS).optional(),
  INTEGRATIONS_ENABLED: oneOf(INTEGRATION_PROVIDERS).optional(),
  PAYMENTS_ENABLED: oneOf(PAYMENT_GATEWAYS).optional(),
  GUARDIAN_VERIFIERS: oneOf(GUARDIAN_VERIFIER_DRIVERS).optional(),
});

export type EditionEnv = z.input<typeof editionEnvSchema>;

export interface EditionConfig {
  deploymentMode: DeploymentMode;
  egressPolicy: EgressPolicy;
  /** `onprem` + `none`. */
  airGapped: boolean;
  egressAllowlist: string[];
  captcha: { default: 'proof_of_work'; thirdParty: ThirdPartyCaptchaProvider[] };
  /** `form.analytics` (GA4, GTM, Meta Pixel); off when air-gapped. */
  thirdPartyAnalytics: ThirdPartyAnalytics[];
  integrations: IntegrationProvider[];
  payments: PaymentGateway[];
  guardianVerifiers: GuardianVerifierDriver[];
  /** Settings that were accepted but have no effect in this edition. */
  notices: string[];
}

const DEFAULT_EGRESS: Record<DeploymentMode, EgressPolicy> = { saas: 'open', onprem: 'allowlist' };
const NEEDS_EGRESS = 'is unavailable when EGRESS_POLICY=none';

export const editionConfigSchema = z
  .preprocess(
    (env) =>
      env !== null && typeof env === 'object'
        ? Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''))
        : env,
    editionEnvSchema,
  )
  .superRefine((env, ctx) => {
    const mode = env.DEPLOYMENT_MODE;
    const egress = env.EGRESS_POLICY ?? DEFAULT_EGRESS[mode];
    const issue = (path: keyof typeof env, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });

    if (mode === 'saas' && egress === 'none') issue('EGRESS_POLICY', 'none (air-gapped) requires DEPLOYMENT_MODE=onprem');
    if (env.CAPTCHA_DEFAULT !== undefined && (THIRD_PARTY_CAPTCHA_PROVIDERS as readonly string[]).includes(env.CAPTCHA_DEFAULT)) {
      issue(
        'CAPTCHA_DEFAULT',
        egress === 'none'
          ? `third-party captcha (${env.CAPTCHA_DEFAULT}) ${NEEDS_EGRESS}`
          : 'must be proof_of_work in every edition (ADR-0011); third-party providers are per-form opt-in through CAPTCHA_PROVIDERS',
      );
    }
    if (env.GUARDIAN_VERIFIERS?.includes('digilocker') && mode !== 'saas') {
      issue('GUARDIAN_VERIFIERS', 'digilocker is available on SaaS only');
    }
    if (egress !== 'none') return;
    for (const p of only(THIRD_PARTY_CAPTCHA_PROVIDERS, env.CAPTCHA_PROVIDERS) ?? []) issue('CAPTCHA_PROVIDERS', `third-party captcha (${p}) ${NEEDS_EGRESS}`);
    for (const p of only(INTEGRATION_PROVIDERS, env.INTEGRATIONS_ENABLED) ?? []) issue('INTEGRATIONS_ENABLED', `integration:${p} ${NEEDS_EGRESS}`);
  })
  .transform((env): EditionConfig => {
    const mode = env.DEPLOYMENT_MODE;
    const egress = env.EGRESS_POLICY ?? DEFAULT_EGRESS[mode];
    const open = egress === 'open';
    const allowlist = env.EGRESS_ALLOWLIST && [...new Set(env.EGRESS_ALLOWLIST.map((h) => h.toLowerCase()))];
    const captcha = only(THIRD_PARTY_CAPTCHA_PROVIDERS, env.CAPTCHA_PROVIDERS);
    const integrations = only(INTEGRATION_PROVIDERS, env.INTEGRATIONS_ENABLED);
    const payments = only(PAYMENT_GATEWAYS, env.PAYMENTS_ENABLED);
    const notices: string[] = [];
    if (egress === 'open' && allowlist?.length) notices.push('EGRESS_ALLOWLIST is ignored when EGRESS_POLICY=open');
    if (egress === 'none' && env.PAYMENTS_ENABLED?.length) notices.push('PAYMENTS_ENABLED is ignored when EGRESS_POLICY=none');
    return {
      deploymentMode: mode,
      egressPolicy: egress,
      airGapped: mode === 'onprem' && egress === 'none',
      egressAllowlist: open ? [] : (allowlist ?? []),
      captcha: { default: 'proof_of_work', thirdParty: captcha ?? (open ? [...THIRD_PARTY_CAPTCHA_PROVIDERS] : []) },
      thirdPartyAnalytics: egress === 'none' ? [] : [...THIRD_PARTY_ANALYTICS],
      integrations: integrations ?? (open ? [...INTEGRATION_PROVIDERS] : []),
      payments: egress === 'none' ? [] : (payments ?? (open ? [...PAYMENT_GATEWAYS] : [])),
      guardianVerifiers: only(GUARDIAN_VERIFIER_DRIVERS, env.GUARDIAN_VERIFIERS) ?? ['existing_account', 'manual_review'],
      notices,
    };
  });

export class ConfigError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

export type ParseResult = { ok: true; config: EditionConfig } | { ok: false; errors: string[] };

export function parseEditionConfig(env: Record<string, string | undefined>): ParseResult {
  const r = editionConfigSchema.safeParse(env);
  if (r.success) return { ok: true, config: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

/** Refuses to start on invalid config, listing every error. */
export function loadEditionConfig(env: Record<string, string | undefined>): EditionConfig {
  const r = parseEditionConfig(env);
  if (!r.ok) throw new ConfigError(r.errors);
  return r.config;
}

/**
 * Whether the edition can run a feature at all (the first factor of `effectiveFeatures`, architecture §1.5).
 * Plans, licences and org restrictions narrow this further.
 */
export function isEditionFeatureAvailable(edition: EditionConfig, feature: FeatureId): boolean {
  const [kind, name] = splitFeature(feature);
  if (kind === 'integration') return (edition.integrations as readonly string[]).includes(name);
  if (feature === 'field:payment' || feature === 'capability:payments') return edition.payments.length > 0;
  if (feature === 'capability:guardian_digilocker') return edition.guardianVerifiers.includes('digilocker');
  if (kind !== 'capability') return true;
  // Prefix rules, so ids the schema adds later in these families still fail closed when air-gapped.
  if (name.startsWith('captcha_')) {
    const provider = name.slice('captcha_'.length);
    return provider === 'proof_of_work' || (edition.captcha.thirdParty as readonly string[]).includes(provider);
  }
  if (name.startsWith('analytics_')) return (edition.thirdPartyAnalytics as readonly string[]).includes(name.slice('analytics_'.length));
  return true;
}

export interface FeatureScope {
  /** `planFeatures(org.plan)` on SaaS, `license.features` on-prem. */
  entitled: ReadonlySet<FeatureId>;
  /** Org-admin restrictions (P3 ENT-09). */
  restricted?: ReadonlySet<FeatureId>;
}

export function isFeatureEnabled(edition: EditionConfig, feature: FeatureId, scope: FeatureScope): boolean {
  return isEditionFeatureAvailable(edition, feature) && scope.entitled.has(feature) && !scope.restricted?.has(feature);
}

/** For template `requiredFeatures` and publish checks: the features the edition cannot run, in input order. */
export function missingEditionFeatures(edition: EditionConfig, required: readonly FeatureId[]): FeatureId[] {
  return required.filter((f) => !isEditionFeatureAvailable(edition, f));
}

function splitFeature(feature: FeatureId): [string, string] {
  const i = feature.indexOf(':');
  return [feature.slice(0, i), feature.slice(i + 1)];
}
