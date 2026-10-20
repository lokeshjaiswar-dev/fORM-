import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { CAPTCHA_PROVIDERS, type Captcha, type CaptchaVerifyContext } from '@form/ports';
import { expectPortError, useSubject, type ContractSetup, type ContractSubject } from './contract.ts';

export interface CaptchaContractSubject extends ContractSubject<Captcha> {
  /** A token the implementation accepts once for `ctx`, as the widget on the respondent page would produce it. */
  solve(ctx: CaptchaVerifyContext): Promise<string>;
  /** Proof of work signs the org and form into each challenge, so a token for one form fails on another. */
  bindsForm: boolean;
  /** The provider reports the action a token was made for (reCAPTCHA v3, Turnstile). */
  checksAction: boolean;
  /** Values that must never reach the respondent page through `publicConfig` (secrets, HMAC keys). */
  secrets: string[];
  /** Moves the subject's clock past a token's lifetime; omit when the provider checks expiry on its side. */
  expire?: () => void;
  /** The same provider with its verification backend down; omit when verification is local. */
  unreachable?: () => Captcha;
}

/** The org every contract case verifies for; a store with an org foreign key (Postgres) needs it seeded. */
export const CAPTCHA_CONTRACT_ORG_ID = '0190f1d2-0000-7000-8000-000000000001';

const ctx = (formId = 'form-1', expectedAction?: string): CaptchaVerifyContext => ({
  orgId: CAPTCHA_CONTRACT_ORG_ID,
  formId,
  ipHash: 'aGFzaA',
  ...(expectedAction ? { expectedAction } : {}),
});

const b64 = (s: string) => Buffer.from(s).toString('base64');

export function runCaptchaContract(label: string, setup: ContractSetup<CaptchaContractSubject>): void {
  describe(`Captcha contract: ${label}`, () => {
    const subject = useSubject(setup);
    const captcha = () => subject().impl;

    it('publishes its provider and no secret', () => {
      const c = captcha().publicConfig();
      expect(CAPTCHA_PROVIDERS).toContain(captcha().provider);
      expect(c.provider).toBe(captcha().provider);
      if (c.provider === 'proof_of_work') expect(c.powChallengeUrl).toEqual(expect.any(String));
      else expect(c.siteKey).toEqual(expect.any(String));
      for (const s of subject().secrets) expect(JSON.stringify(c)).not.toContain(s);
    });

    it('accepts a solved token once', async () => {
      const token = await subject().solve(ctx('form-1', 'submit'));
      const first = await captcha().verify(token, ctx('form-1', 'submit'));
      expect(first.ok).toBe(true);
      if (first.score !== undefined) expect(first.score).toBeGreaterThanOrEqual(0);
      if (first.score !== undefined) expect(first.score).toBeLessThanOrEqual(1);
      expect((await captcha().verify(token, ctx('form-1', 'submit'))).ok).toBe(false);
    });

    it.each(['', 'x', 'a'.repeat(10_000), '%%%', b64('{}'), b64('null'), b64('[]'), b64('{"number":1}')])('refuses the junk token %#, without throwing', async (token) => {
      expect((await captcha().verify(token, ctx())).ok).toBe(false);
    });

    it('binds a token to the form it was solved for', async (t) => {
      if (!subject().bindsForm) return t.skip();
      const token = await subject().solve(ctx('form-1'));
      expect((await captcha().verify(token, ctx('form-2'))).ok).toBe(false);
      expect((await captcha().verify(token, { ...ctx('form-1'), orgId: '0190f1d2-0000-7000-8000-000000000002' })).ok).toBe(false);
    });

    it('refuses a token made for another action', async (t) => {
      if (!subject().checksAction) return t.skip();
      const token = await subject().solve(ctx('form-1', 'submit'));
      expect((await captcha().verify(token, ctx('form-1', 'login'))).ok).toBe(false);
    });

    it('refuses a solved token once it has expired', async (t) => {
      const expire = subject().expire;
      if (!expire) return t.skip();
      const token = await subject().solve(ctx());
      expire();
      expect((await captcha().verify(token, ctx())).ok).toBe(false);
    });

    it("reports an unreachable provider as 'unavailable', never as a pass", async (t) => {
      const down = subject().unreachable;
      if (!down) return t.skip();
      const token = await subject().solve(ctx());
      await expectPortError(down().verify(token, ctx()), 'unavailable');
    });
  });
}

/** What the ALTCHA widget does in the browser: find the number, then send the solution as base64 JSON. */
export function solveAltcha(c: { algorithm: string; challenge: string; maxnumber: number; salt: string; signature: string }): string {
  for (let n = 0; n <= c.maxnumber; n++) {
    if (createHash('sha256').update(`${c.salt}${n}`).digest('hex') === c.challenge) {
      return b64(JSON.stringify({ algorithm: c.algorithm, challenge: c.challenge, number: n, salt: c.salt, signature: c.signature, took: 1 }));
    }
  }
  throw new Error('challenge has no solution below maxnumber');
}

export interface SiteverifyMock {
  url: string;
  secret: string;
  /** A token the mock accepts once, as the provider's widget would hand it to the page. */
  issue(o?: { action?: string; score?: number }): string;
  /** Requests the mock received, form fields parsed. */
  readonly requests: ReadonlyArray<Record<string, string>>;
  close(): Promise<void>;
}

/** A siteverify endpoint that behaves like hCaptcha, Turnstile and reCAPTCHA: secret check, single-use tokens, action and score. */
export async function startSiteverifyMock(): Promise<SiteverifyMock> {
  const secret = randomBytes(16).toString('hex');
  const tokens = new Map<string, { action?: string; score?: number }>();
  const requests: Record<string, string>[] = [];
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(parts).toString('utf8')));
      requests.push(form);
      const reply = (body: object) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST') return reply({ success: false, 'error-codes': ['bad-request'] });
      if (form.secret !== secret) return reply({ success: false, 'error-codes': ['invalid-input-secret'] });
      const t = form.response === undefined ? undefined : tokens.get(form.response);
      if (!t) return reply({ success: false, 'error-codes': ['invalid-input-response'] });
      tokens.delete(form.response!);
      reply({ success: true, challenge_ts: new Date().toISOString(), hostname: 'forms.formsuser.test', ...t });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/siteverify`,
    secret,
    requests,
    issue(o = {}) {
      const token = randomBytes(24).toString('base64url');
      tokens.set(token, o);
      return token;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
