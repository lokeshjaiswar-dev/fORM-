import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { PortError, type Captcha, type CaptchaVerifyContext } from '@form/ports';
import type { CaptchaReplayStore } from './replay.ts';

/** An ALTCHA challenge (v1 wire format): the widget finds `number` with sha256(salt + number) = challenge. */
export interface AltchaChallenge {
  algorithm: 'SHA-256';
  challenge: string;
  maxnumber: number;
  salt: string;
  signature: string;
}

export interface ProofOfWorkOptions {
  /** Signs challenges; at least 32 bytes, the same on every API replica. */
  hmacKey: Uint8Array;
  /** Where the respondent page fetches a challenge (published in `publicConfig`). */
  challengeUrl: string;
  replay: CaptchaReplayStore;
  /** Upper bound of the search; the default takes a browser well under a second. */
  maxNumber?: number;
  /** How long a challenge can be solved and redeemed. Default 10 minutes. */
  expiresSec?: number;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

export interface ProofOfWorkCaptcha extends Captcha {
  /** A fresh challenge bound to the org and form; `maxNumber` raises the work (see `powDifficulty`). */
  challenge(ctx: Pick<CaptchaVerifyContext, 'orgId' | 'formId'>, o?: { maxNumber?: number }): AltchaChallenge;
}

export const DEFAULT_POW_MAX_NUMBER = 50_000;
const MAX_NUMBER_CEILING = 10_000_000;
const MAX_TOKEN_CHARS = 4096;
const HEX64 = /^[0-9a-f]{64}$/;
/**
 * The salt as issued, and nothing else. The trailing `&` closes the expiry: without it, digits moved from `number` to
 * the end of the salt keep sha256(salt + number) and its signature while pushing the expiry out (ALTCHA salt splicing).
 */
const SALT = /^[0-9a-f]{24}\?expires=(\d{1,12})&$/;
/** How far a replica's clock may run behind the one that issued the challenge. */
const CLOCK_SKEW_SEC = 60;

/** Adaptive difficulty (architecture §4.4): more work as the spam score rises. */
export function powDifficulty(spamScore: number, base = DEFAULT_POW_MAX_NUMBER): number {
  const s = Number.isFinite(spamScore) ? Math.min(Math.max(spamScore, 0), 1) : 1;
  return Math.min(MAX_NUMBER_CEILING, Math.round(base * (s >= 0.8 ? 20 : s >= 0.5 ? 5 : 1)));
}

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

interface Solution {
  algorithm: string;
  challenge: string;
  number: number;
  salt: string;
  signature: string;
}

function parseToken(token: string): Solution | null {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS || !/^[A-Za-z0-9+/=_-]+$/.test(token)) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const { algorithm, challenge, number, salt, signature } = v as Record<string, unknown>;
  if (typeof algorithm !== 'string' || typeof challenge !== 'string' || typeof salt !== 'string' || typeof signature !== 'string') return null;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 || number > MAX_NUMBER_CEILING || salt.length > 256) return null;
  return { algorithm, challenge, number, salt, signature };
}

/**
 * Proof of work, ALTCHA-compatible (ADR-0011): the default captcha in every edition and the only one air-gapped. It
 * makes no outbound call. Challenges carry their expiry in the salt (closed by `&`, never further out than one lifetime)
 * and an HMAC under a key derived per org and form, so a solution for one form does not pass on another; redeemed
 * challenges are remembered until they expire.
 */
export function createProofOfWorkCaptcha(o: ProofOfWorkOptions): ProofOfWorkCaptcha {
  if (o.hmacKey.byteLength < 32) throw new PortError('invalid_argument', 'the proof-of-work HMAC key must be at least 32 bytes');
  const master = Buffer.from(o.hmacKey);
  const now = o.now ?? Date.now;
  const expiresSec = o.expiresSec ?? 600;
  const defaultMax = o.maxNumber ?? DEFAULT_POW_MAX_NUMBER;
  const formKey = (orgId: string, formId: string) => createHmac('sha256', master).update(`form:pow:v1|${orgId}|${formId}`).digest();
  const sign = (orgId: string, formId: string, challenge: string) => createHmac('sha256', formKey(orgId, formId)).update(challenge).digest('hex');

  return {
    provider: 'proof_of_work',

    publicConfig: () => ({ provider: 'proof_of_work', powChallengeUrl: o.challengeUrl }),

    challenge(ctx, c = {}) {
      if (ctx.orgId.length === 0 || ctx.formId.length === 0) throw new PortError('invalid_argument', 'orgId and formId are required');
      const maxnumber = c.maxNumber ?? defaultMax;
      if (!Number.isSafeInteger(maxnumber) || maxnumber < 1 || maxnumber > MAX_NUMBER_CEILING) throw new PortError('invalid_argument', `maxNumber must be 1..${MAX_NUMBER_CEILING}`);
      const salt = `${randomBytes(12).toString('hex')}?expires=${Math.floor(now() / 1000) + expiresSec}&`;
      const secret = randomInt(0, maxnumber + 1);
      const challenge = sha256Hex(`${salt}${secret}`);
      return { algorithm: 'SHA-256', challenge, maxnumber, salt, signature: sign(ctx.orgId, ctx.formId, challenge) };
    },

    async verify(token, ctx) {
      const s = parseToken(token);
      if (!s || s.algorithm !== 'SHA-256' || !HEX64.test(s.challenge) || !HEX64.test(s.signature)) return { ok: false };
      const m = SALT.exec(s.salt);
      if (!m) return { ok: false };
      const expires = Number(m[1]);
      const t = now();
      if (expires * 1000 <= t || expires * 1000 > t + (expiresSec + CLOCK_SKEW_SEC) * 1000) return { ok: false };
      if (sha256Hex(`${s.salt}${s.number}`) !== s.challenge) return { ok: false };
      if (!timingSafeEqual(Buffer.from(sign(ctx.orgId, ctx.formId, s.challenge), 'hex'), Buffer.from(s.signature, 'hex'))) return { ok: false };
      const redeemed = await o.replay.redeem(ctx.orgId, Buffer.from(s.challenge, 'hex'), new Date(expires * 1000));
      return { ok: redeemed };
    },
  };
}
