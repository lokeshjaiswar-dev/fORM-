import { PortError, type Captcha, type EgressGuard, type ThirdPartyCaptchaProvider } from '@form/ports';
import { egressHttp } from '../egress/http.ts';

/** The providers' server-side verification endpoints. */
export const SITEVERIFY_URLS: Record<ThirdPartyCaptchaProvider, string> = {
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  recaptcha_v3: 'https://www.google.com/recaptcha/api/siteverify',
};

export interface ThirdPartyCaptchaOptions {
  provider: ThirdPartyCaptchaProvider;
  siteKey: string;
  secret: string;
  /** Every verification is an outbound call: it passes the egress guard and connects to the address it vetted. */
  egress: EgressGuard;
  /** The edition's opt-ins (`EditionConfig.captcha.thirdParty`); any other provider is refused here. */
  enabled: readonly ThirdPartyCaptchaProvider[];
  /** Default: the provider's siteverify endpoint. */
  verifyUrl?: string;
  /** reCAPTCHA v3 scores below this fail. Default 0.5. */
  minScore?: number;
  timeoutMs?: number;
}

/** Errors that mean our configuration or the provider is broken, not that the respondent failed. */
const OUR_FAULT = new Set(['missing-input-secret', 'invalid-input-secret', 'sitekey-secret-mismatch', 'invalid-sitekey', 'internal-error', 'bad-request']);
const MAX_TOKEN_CHARS = 4096;

interface SiteverifyReply {
  success?: unknown;
  score?: unknown;
  action?: unknown;
  'error-codes'?: unknown;
}

/**
 * hCaptcha, Turnstile and reCAPTCHA v3: per-form opt-ins that send respondent data to a third party (architecture §4.4),
 * so they need the edition to allow them and the egress guard to pass the provider. The raw IP is never sent (the
 * context has only its salted hash). `score` is reCAPTCHA's (1.0 most likely human); the others report none.
 */
export function createThirdPartyCaptcha(o: ThirdPartyCaptchaOptions): Captcha {
  if (!o.enabled.includes(o.provider)) throw new PortError('egress_denied', `captcha provider ${o.provider} is not enabled in this edition (CAPTCHA_PROVIDERS)`);
  if (o.siteKey.length === 0 || o.secret.length === 0) throw new PortError('invalid_argument', 'siteKey and secret are required');
  const url = new URL(o.verifyUrl ?? SITEVERIFY_URLS[o.provider]);
  const minScore = o.minScore ?? 0.5;

  return {
    provider: o.provider,

    publicConfig: () => ({ provider: o.provider, siteKey: o.siteKey }),

    async verify(token, ctx) {
      if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return { ok: false };
      const body = new URLSearchParams({ secret: o.secret, response: token, ...(o.provider === 'hcaptcha' ? { sitekey: o.siteKey } : {}) }).toString();
      const res = await egressHttp(o.egress, url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        timeoutMs: o.timeoutMs ?? 5000,
        maxResponseBytes: 64 * 1024,
      });
      if (res.status !== 200) throw new PortError('unavailable', `${o.provider} siteverify answered ${res.status}`);
      const reply = res.json() as SiteverifyReply;
      if (reply.success !== true) {
        const codes = Array.isArray(reply['error-codes']) ? reply['error-codes'].filter((c): c is string => typeof c === 'string') : [];
        if (codes.some((c) => OUR_FAULT.has(c))) throw new PortError('unavailable', `${o.provider} siteverify: ${codes.join(', ')}`);
        return { ok: false };
      }
      if (ctx.expectedAction !== undefined && typeof reply.action === 'string' && reply.action !== ctx.expectedAction) return { ok: false };
      if (o.provider === 'recaptcha_v3') {
        if (typeof reply.score !== 'number' || (ctx.expectedAction !== undefined && reply.action !== ctx.expectedAction)) return { ok: false };
        return { ok: reply.score >= minScore, score: reply.score };
      }
      return { ok: true };
    },
  };
}
