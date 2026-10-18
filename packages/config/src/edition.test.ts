import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  INTEGRATION_PROVIDERS,
  isEditionFeatureAvailable,
  isFeatureEnabled,
  loadEditionConfig,
  missingEditionFeatures,
  parseEditionConfig,
  type FeatureId,
} from './index.ts';

const AIR_GAPPED = { DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none' };

function errorsOf(env: Record<string, string | undefined>): string[] {
  const r = parseEditionConfig(env);
  if (r.ok) throw new Error('expected the config to be rejected');
  return r.errors;
}

describe('edition defaults', () => {
  it('SaaS is open with every internet feature', () => {
    const c = loadEditionConfig({ DEPLOYMENT_MODE: 'saas' });
    expect(c).toMatchObject({ egressPolicy: 'open', airGapped: false, payments: ['stripe', 'razorpay'] });
    expect(c.integrations).toEqual([...INTEGRATION_PROVIDERS]);
    expect(c.captcha).toEqual({ default: 'proof_of_work', thirdParty: ['hcaptcha', 'turnstile', 'recaptcha_v3'] });
    expect(c.guardianVerifiers).toEqual(['existing_account', 'manual_review']);
    expect(c.thirdPartyAnalytics).toEqual(['ga4', 'gtm', 'meta_pixel']);
  });

  it('on-prem defaults to an allowlist with internet features off until enabled', () => {
    const c = loadEditionConfig({ DEPLOYMENT_MODE: 'onprem', EGRESS_ALLOWLIST: 'SMTP.acme.local, hooks.acme.local:8443,smtp.acme.local' });
    expect(c).toMatchObject({ egressPolicy: 'allowlist', airGapped: false, integrations: [], payments: [] });
    expect(c.captcha.thirdParty).toEqual([]);
    expect(c.egressAllowlist).toEqual(['smtp.acme.local', 'hooks.acme.local:8443']);
  });

  it('on-prem with an allowlist can opt in to integrations and gateways', () => {
    const c = loadEditionConfig({ DEPLOYMENT_MODE: 'onprem', INTEGRATIONS_ENABLED: 'slack', PAYMENTS_ENABLED: 'razorpay', CAPTCHA_PROVIDERS: 'hcaptcha' });
    expect(c).toMatchObject({ integrations: ['slack'], payments: ['razorpay'], captcha: { thirdParty: ['hcaptcha'] } });
  });

  it('air-gapped turns every internet feature off', () => {
    const c = loadEditionConfig({ ...AIR_GAPPED, EGRESS_ALLOWLIST: 'smtp.corp.local' });
    expect(c).toMatchObject({ airGapped: true, integrations: [], payments: [], captcha: { thirdParty: [] }, thirdPartyAnalytics: [], egressAllowlist: ['smtp.corp.local'] });
    expect(c.notices).toEqual([]);
  });

  it('treats empty strings as unset', () => {
    expect(loadEditionConfig({ DEPLOYMENT_MODE: 'saas', EGRESS_POLICY: '', INTEGRATIONS_ENABLED: undefined }).egressPolicy).toBe('open');
  });

  it('notes settings that have no effect', () => {
    expect(loadEditionConfig({ ...AIR_GAPPED, PAYMENTS_ENABLED: 'stripe' }).notices).toEqual(['PAYMENTS_ENABLED is ignored when EGRESS_POLICY=none']);
    const open = loadEditionConfig({ DEPLOYMENT_MODE: 'saas', EGRESS_ALLOWLIST: 'a.example' });
    expect(open.egressAllowlist).toEqual([]);
    expect(open.notices).toEqual(['EGRESS_ALLOWLIST is ignored when EGRESS_POLICY=open']);
  });
});

describe('air-gapped rejections', () => {
  it('rejects integration:*', () => {
    expect(errorsOf({ ...AIR_GAPPED, INTEGRATIONS_ENABLED: 'google_sheets,slack' })).toEqual([
      'INTEGRATIONS_ENABLED: integration:google_sheets is unavailable when EGRESS_POLICY=none',
      'INTEGRATIONS_ENABLED: integration:slack is unavailable when EGRESS_POLICY=none',
    ]);
  });

  it('rejects third-party captcha as a provider and as the default', () => {
    expect(errorsOf({ ...AIR_GAPPED, CAPTCHA_PROVIDERS: 'turnstile', CAPTCHA_DEFAULT: 'hcaptcha' })).toEqual([
      'CAPTCHA_DEFAULT: third-party captcha (hcaptcha) is unavailable when EGRESS_POLICY=none',
      'CAPTCHA_PROVIDERS: third-party captcha (turnstile) is unavailable when EGRESS_POLICY=none',
    ]);
  });

  it('still reports air-gap errors next to unknown values', () => {
    expect(errorsOf({ ...AIR_GAPPED, INTEGRATIONS_ENABLED: 'slack,myspace', CAPTCHA_PROVIDERS: 'hcaptcha,acme', CAPTCHA_DEFAULT: 'nope' })).toEqual([
      'CAPTCHA_DEFAULT: expected one of: proof_of_work, hcaptcha, turnstile, recaptcha_v3',
      'CAPTCHA_PROVIDERS.1: expected one of: hcaptcha, turnstile, recaptcha_v3',
      expect.stringMatching(/^INTEGRATIONS_ENABLED\.1: expected one of: google_sheets, /),
      'CAPTCHA_PROVIDERS: third-party captcha (hcaptcha) is unavailable when EGRESS_POLICY=none',
      'INTEGRATIONS_ENABLED: integration:slack is unavailable when EGRESS_POLICY=none',
    ]);
  });

  it('accepts proof of work', () => {
    expect(loadEditionConfig({ ...AIR_GAPPED, CAPTCHA_DEFAULT: 'proof_of_work' }).captcha.default).toBe('proof_of_work');
  });

  it('reports integration features as unavailable', () => {
    const c = loadEditionConfig(AIR_GAPPED);
    expect(isEditionFeatureAvailable(c, 'integration:google_sheets')).toBe(false);
    expect(isEditionFeatureAvailable(c, 'field:payment')).toBe(false);
    expect(isEditionFeatureAvailable(c, 'capability:payments')).toBe(false);
    expect(isEditionFeatureAvailable(c, 'field:address')).toBe(true);
    expect(isEditionFeatureAvailable(c, 'capability:appointments')).toBe(true);
    expect(missingEditionFeatures(c, ['field:address', 'integration:slack', 'field:payment'])).toEqual(['integration:slack', 'field:payment']);
  });
});

describe('internet-dependent capabilities', () => {
  const air = loadEditionConfig(AIR_GAPPED);
  const saas = loadEditionConfig({ DEPLOYMENT_MODE: 'saas', CAPTCHA_PROVIDERS: 'turnstile' });

  it.each<[FeatureId, boolean, boolean]>([
    ['capability:captcha_proof_of_work', true, true],
    ['capability:captcha_turnstile', false, true],
    ['capability:captcha_hcaptcha', false, false],
    ['capability:captcha_someday', false, false],
    ['capability:analytics_ga4', false, true],
    ['capability:analytics_meta_pixel', false, true],
    ['capability:analytics_someday', false, false],
  ])('%s: air-gapped %s, SaaS %s', (feature, inAir, inSaas) => {
    expect(isEditionFeatureAvailable(air, feature)).toBe(inAir);
    expect(isEditionFeatureAvailable(saas, feature)).toBe(inSaas);
  });
});

describe('other rejections', () => {
  it('lists every error at once', () => {
    expect(errorsOf({ DEPLOYMENT_MODE: 'cloud', EGRESS_POLICY: 'closed', INTEGRATIONS_ENABLED: 'myspace' })).toHaveLength(3);
    expect(() => loadEditionConfig({})).toThrow(ConfigError);
    let error: unknown;
    try {
      loadEditionConfig({ DEPLOYMENT_MODE: 'x' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).errors).toEqual([expect.stringMatching(/^DEPLOYMENT_MODE: /)]);
    expect((error as ConfigError).message).toMatch(/^Invalid configuration:\n {2}- DEPLOYMENT_MODE/);
  });

  it('keeps air-gapped on-prem only', () => {
    expect(errorsOf({ DEPLOYMENT_MODE: 'saas', EGRESS_POLICY: 'none' })).toEqual(['EGRESS_POLICY: none (air-gapped) requires DEPLOYMENT_MODE=onprem']);
  });

  it('keeps proof of work the platform default (ADR-0011)', () => {
    expect(errorsOf({ DEPLOYMENT_MODE: 'saas', CAPTCHA_DEFAULT: 'recaptcha_v3' })).toEqual([
      'CAPTCHA_DEFAULT: must be proof_of_work in every edition (ADR-0011); third-party providers are per-form opt-in through CAPTCHA_PROVIDERS',
    ]);
  });

  it('keeps DigiLocker on SaaS', () => {
    expect(errorsOf({ DEPLOYMENT_MODE: 'onprem', GUARDIAN_VERIFIERS: 'manual_review,digilocker' })).toEqual(['GUARDIAN_VERIFIERS: digilocker is available on SaaS only']);
    const saas = loadEditionConfig({ DEPLOYMENT_MODE: 'saas', GUARDIAN_VERIFIERS: 'digilocker' });
    expect(isEditionFeatureAvailable(saas, 'capability:guardian_digilocker')).toBe(true);
  });

  it('validates allowlist hosts', () => {
    expect(errorsOf({ DEPLOYMENT_MODE: 'onprem', EGRESS_ALLOWLIST: 'ok.local:65535,http://bad.local,-x.local,a.b:99999,a.b:0' })).toEqual([
      'EGRESS_ALLOWLIST.1: expected host or host:port (port 1-65535)',
      'EGRESS_ALLOWLIST.2: expected host or host:port (port 1-65535)',
      'EGRESS_ALLOWLIST.3: expected host or host:port (port 1-65535)',
      'EGRESS_ALLOWLIST.4: expected host or host:port (port 1-65535)',
    ]);
  });
});

describe('isFeatureEnabled', () => {
  const saas = loadEditionConfig({ DEPLOYMENT_MODE: 'saas', INTEGRATIONS_ENABLED: 'slack' });
  const entitled = new Set<FeatureId>(['integration:slack', 'integration:hubspot', 'field:payment']);

  it('intersects edition, entitlement and org restrictions', () => {
    expect(isFeatureEnabled(saas, 'integration:slack', { entitled })).toBe(true);
    expect(isFeatureEnabled(saas, 'integration:hubspot', { entitled })).toBe(false);
    expect(isFeatureEnabled(saas, 'field:address', { entitled })).toBe(false);
    expect(isFeatureEnabled(saas, 'field:payment', { entitled, restricted: new Set<FeatureId>(['field:payment']) })).toBe(false);
    expect(isFeatureEnabled(saas, 'field:payment', { entitled })).toBe(true);
  });
});
