import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_MODES,
  EGRESS_POLICIES,
  RESTRICTED_EDITION,
  editionSummary,
  editionSummarySchema,
  isEditionFeatureAvailable,
  loadEditionConfig,
  parseEditionConfig,
  runtimeEdition,
  type DeploymentMode,
  type EgressPolicy,
  type FeatureId,
} from './index.ts';

/*
 * The edition matrix (FND-19): every DEPLOYMENT_MODE x EGRESS_POLICY, with defaults and with every opt-in set, against
 * every family of edition-gated feature. `x` = rejected at boot.
 */

type Cell = `${DeploymentMode}/${EgressPolicy}`;
const CELLS: Cell[] = DEPLOYMENT_MODES.flatMap((m) => EGRESS_POLICIES.map((e): Cell => `${m}/${e}`));

const FEATURES: FeatureId[] = [
  'field:short_text',
  'capability:appointments',
  'integration:google_sheets',
  'integration:slack',
  'field:payment',
  'capability:payments',
  'capability:captcha_proof_of_work',
  'capability:captcha_hcaptcha',
  'capability:captcha_turnstile',
  'capability:analytics_ga4',
  'capability:guardian_digilocker',
];

/** One letter per FEATURES entry: `1` available, `0` not. */
const DEFAULTS: Record<Cell, string> = {
  'saas/open': '11111111110',
  'saas/allowlist': '11000010010',
  'saas/none': 'x',
  'onprem/open': '11111111110',
  'onprem/allowlist': '11000010010',
  'onprem/none': '11000010000',
};

const OPT_IN = { INTEGRATIONS_ENABLED: 'slack', PAYMENTS_ENABLED: 'razorpay', CAPTCHA_PROVIDERS: 'turnstile' };
const OPTED_IN: Record<Cell, string> = {
  'saas/open': '11011110110',
  'saas/allowlist': '11011110110',
  'saas/none': 'x',
  'onprem/open': '11011110110',
  'onprem/allowlist': '11011110110',
  'onprem/none': 'x',
};

function row(cell: Cell, extra: Record<string, string> = {}): string {
  const [mode, egress] = cell.split('/') as [DeploymentMode, EgressPolicy];
  const r = parseEditionConfig({ DEPLOYMENT_MODE: mode, EGRESS_POLICY: egress, ...extra });
  if (!r.ok) return 'x';
  const config = r.config;
  const summary = editionSummarySchema.parse(JSON.parse(JSON.stringify(editionSummary(config))));
  const bits = FEATURES.map((f) => (isEditionFeatureAvailable(config, f) ? '1' : '0')).join('');
  /* The builder decides from the summary it fetched: it must agree with the server's full config. */
  expect(FEATURES.map((f) => (isEditionFeatureAvailable(summary, f) ? '1' : '0')).join('')).toBe(bits);
  return bits;
}

describe('edition matrix', () => {
  it.each(CELLS)('%s with defaults', (cell) => {
    expect(row(cell)).toBe(DEFAULTS[cell]);
  });

  it.each(CELLS)('%s with every internet feature opted in', (cell) => {
    expect(row(cell, OPT_IN)).toBe(OPTED_IN[cell]);
  });

  it.each(CELLS)('%s: DigiLocker only on SaaS', (cell) => {
    const bits = row(cell, { GUARDIAN_VERIFIERS: 'existing_account,digilocker' });
    expect(bits === 'x' ? 'x' : bits.at(-1)).toBe(cell === 'saas/none' ? 'x' : cell.startsWith('saas/') ? '1' : 'x');
  });

  it('RESTRICTED_EDITION is the air-gapped edition, and allows nothing any edition refuses', () => {
    expect(RESTRICTED_EDITION).toEqual(editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none' })));
    for (const cell of CELLS) {
      const bits = row(cell);
      if (bits === 'x') continue;
      FEATURES.forEach((f, i) => {
        if (isEditionFeatureAvailable(RESTRICTED_EDITION, f)) expect(bits[i], `${cell} ${f}`).toBe('1');
      });
    }
  });

  it('runtimeEdition names the runtime projection edition', () => {
    expect(runtimeEdition(editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'saas' })))).toBe('saas');
    expect(runtimeEdition(editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'onprem' })))).toBe('onprem');
    expect(runtimeEdition(RESTRICTED_EDITION)).toBe('airgapped');
  });
});

describe('editionSummary', () => {
  it('leaves out the allowlist and the notices', () => {
    const config = loadEditionConfig({ DEPLOYMENT_MODE: 'onprem', EGRESS_ALLOWLIST: 'smtp.corp.local', PAYMENTS_ENABLED: 'stripe' });
    const summary = editionSummary(config);
    expect(JSON.stringify(summary)).not.toContain('smtp.corp.local');
    expect(Object.keys(summary).sort()).toEqual(['airGapped', 'captcha', 'deploymentMode', 'egressPolicy', 'guardianVerifiers', 'integrations', 'payments', 'thirdPartyAnalytics']);
  });

  it('the schema rejects inconsistent or unknown values and drops unknown keys', () => {
    const saas = editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'saas' }));
    expect(editionSummarySchema.safeParse({ ...saas, airGapped: true }).success).toBe(false);
    expect(editionSummarySchema.safeParse({ ...saas, integrations: ['myspace'] }).success).toBe(false);
    expect(editionSummarySchema.safeParse({ ...saas, payments: ['stripe', 'stripe'] }).success).toBe(false);
    expect(editionSummarySchema.safeParse({ ...saas, captcha: { default: 'hcaptcha', thirdParty: [] } }).success).toBe(false);
    expect(editionSummarySchema.parse({ ...saas, licence: { tier: 'x' } })).toEqual(saas);
  });
});
