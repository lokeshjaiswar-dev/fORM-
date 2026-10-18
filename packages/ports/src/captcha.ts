/** Proof of work is the default in every edition and the only provider air-gapped (ADR-0011). */
export const FIRST_PARTY_CAPTCHA_PROVIDERS = ['proof_of_work'] as const;
/** Opt-in per form; each sends respondent data to a third party and needs egress. */
export const THIRD_PARTY_CAPTCHA_PROVIDERS = ['hcaptcha', 'turnstile', 'recaptcha_v3'] as const;
export const CAPTCHA_PROVIDERS = [...FIRST_PARTY_CAPTCHA_PROVIDERS, ...THIRD_PARTY_CAPTCHA_PROVIDERS] as const;

export type CaptchaProvider = (typeof CAPTCHA_PROVIDERS)[number];
export type ThirdPartyCaptchaProvider = (typeof THIRD_PARTY_CAPTCHA_PROVIDERS)[number];

/** What the runtime projection carries to the respondent page. */
export interface CaptchaPublicConfig {
  provider: CaptchaProvider;
  siteKey?: string;
  powChallengeUrl?: string;
}

export interface CaptchaVerifyContext {
  orgId: string;
  formId: string;
  /** Salted hash, never the raw IP. */
  ipHash?: string;
  expectedAction?: string;
}

export interface Captcha {
  readonly provider: CaptchaProvider;
  publicConfig(): CaptchaPublicConfig;
  verify(token: string, ctx: CaptchaVerifyContext): Promise<{ ok: boolean; score?: number }>;
}
