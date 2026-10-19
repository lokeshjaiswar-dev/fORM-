import { THIRD_PARTY_CAPTCHA_PROVIDERS } from '@form/ports';
import { INTEGRATION_PROVIDERS } from '@form/schema';
import { z } from 'zod';
import { DEPLOYMENT_MODES, EGRESS_POLICIES, GUARDIAN_VERIFIER_DRIVERS, PAYMENT_GATEWAYS, THIRD_PARTY_ANALYTICS, type EditionConfig } from './edition.ts';

/**
 * The edition as the builder sees it (`GET /v1/meta/edition`, FND-19): what this deployment can run. It leaves out
 * the egress allowlist (internal host names) and the operator's config notices.
 */
export type EditionSummary = Omit<EditionConfig, 'egressAllowlist' | 'notices'>;

/** `publicConfig.edition` of a runtime form version. */
export type RuntimeEdition = 'saas' | 'onprem' | 'airgapped';

export function editionSummary(edition: EditionConfig): EditionSummary {
  return {
    deploymentMode: edition.deploymentMode,
    egressPolicy: edition.egressPolicy,
    airGapped: edition.airGapped,
    captcha: { default: edition.captcha.default, thirdParty: [...edition.captcha.thirdParty] },
    thirdPartyAnalytics: [...edition.thirdPartyAnalytics],
    integrations: [...edition.integrations],
    payments: [...edition.payments],
    guardianVerifiers: [...edition.guardianVerifiers],
  };
}

export const runtimeEdition = (edition: Pick<EditionSummary, 'deploymentMode' | 'airGapped'>): RuntimeEdition =>
  edition.airGapped ? 'airgapped' : edition.deploymentMode;

/**
 * What a client assumes while it does not know the edition (offline, API unreachable): every internet feature off,
 * so nothing is offered that the server could refuse.
 */
export const RESTRICTED_EDITION: EditionSummary = {
  deploymentMode: 'onprem',
  egressPolicy: 'none',
  airGapped: true,
  captcha: { default: 'proof_of_work', thirdParty: [] },
  thirdPartyAnalytics: [],
  integrations: [],
  payments: [],
  guardianVerifiers: ['existing_account', 'manual_review'],
};

const distinct = <T extends string>(values: readonly [T, ...T[]]) =>
  z.array(z.enum(values)).refine((xs) => new Set(xs).size === xs.length, { message: 'duplicate entry' });

/** Reads a summary from the API. Unknown keys are dropped, so an older builder keeps working against a newer API. */
export const editionSummarySchema = z
  .object({
    deploymentMode: z.enum(DEPLOYMENT_MODES),
    egressPolicy: z.enum(EGRESS_POLICIES),
    airGapped: z.boolean(),
    captcha: z.object({ default: z.literal('proof_of_work'), thirdParty: distinct(THIRD_PARTY_CAPTCHA_PROVIDERS) }),
    thirdPartyAnalytics: distinct(THIRD_PARTY_ANALYTICS),
    integrations: distinct(INTEGRATION_PROVIDERS),
    payments: distinct(PAYMENT_GATEWAYS),
    guardianVerifiers: distinct(GUARDIAN_VERIFIER_DRIVERS),
  })
  .refine((e) => e.airGapped === (e.deploymentMode === 'onprem' && e.egressPolicy === 'none'), {
    path: ['airGapped'],
    message: 'airGapped must be true exactly for onprem with egress none',
  });
