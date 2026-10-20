import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { THIRD_PARTY_CAPTCHA_PROVIDERS } from '@form/ports';
import { expectPortError, runCaptchaContract, solveAltcha, startSiteverifyMock } from '@form/testkit';
import { createEgressGuard } from '../egress/guard.ts';
import { createProofOfWorkCaptcha, powDifficulty } from './pow.ts';
import { createMemoryReplayStore } from './replay.ts';
import { createThirdPartyCaptcha } from './third-party.ts';

const hmacKey = randomBytes(32);

runCaptchaContract('proof of work', () => {
  let t = Date.now();
  const now = () => t;
  const impl = createProofOfWorkCaptcha({ hmacKey, challengeUrl: 'https://api.form.test/f/x/captcha', replay: createMemoryReplayStore({ now }), maxNumber: 2000, now });
  return {
    impl,
    solve: async (c) => solveAltcha(impl.challenge(c)),
    expire: () => {
      t += 3_600_000;
    },
    bindsForm: true,
    checksAction: false,
    secrets: [hmacKey.toString('hex'), hmacKey.toString('base64')],
  };
});

for (const provider of THIRD_PARTY_CAPTCHA_PROVIDERS) {
  runCaptchaContract(`${provider} → siteverify mock`, async () => {
    const mock = await startSiteverifyMock();
    const egress = createEgressGuard({ policy: 'allowlist', allowlist: ['127.0.0.1'] });
    const make = (verifyUrl: string) =>
      createThirdPartyCaptcha({ provider, siteKey: 'site-key-1', secret: mock.secret, egress, enabled: THIRD_PARTY_CAPTCHA_PROVIDERS, verifyUrl });
    return {
      impl: make(mock.url),
      solve: async (c) => mock.issue({ ...(c.expectedAction && provider !== 'hcaptcha' ? { action: c.expectedAction } : {}), ...(provider === 'recaptcha_v3' ? { score: 0.9 } : {}) }),
      bindsForm: false,
      checksAction: provider !== 'hcaptcha',
      secrets: [mock.secret],
      unreachable: () => make('http://127.0.0.1:1/siteverify'),
      dispose: () => mock.close(),
    };
  });
}

describe('proof of work', () => {
  it('expires challenges', async () => {
    let t = Date.UTC(2027, 0, 1);
    const pow = createProofOfWorkCaptcha({ hmacKey, challengeUrl: 'https://x.test/c', replay: createMemoryReplayStore({ now: () => t }), maxNumber: 100, expiresSec: 60, now: () => t });
    const ctx = { orgId: 'o', formId: 'f' };
    const token = solveAltcha(pow.challenge(ctx));
    t += 61_000;
    expect((await pow.verify(token, ctx)).ok).toBe(false);
  });

  it('refuses a solution whose salt or signature was edited', async () => {
    const pow = createProofOfWorkCaptcha({ hmacKey, challengeUrl: 'https://x.test/c', replay: createMemoryReplayStore(), maxNumber: 100 });
    const ctx = { orgId: 'o', formId: 'f' };
    const solution = JSON.parse(Buffer.from(solveAltcha(pow.challenge(ctx)), 'base64').toString()) as Record<string, unknown>;
    const edit = (patch: Record<string, unknown>) => Buffer.from(JSON.stringify({ ...solution, ...patch })).toString('base64');
    expect((await pow.verify(edit({ salt: `${String(solution.salt).replace(/expires=\d+/, 'expires=9999999999')}` }), ctx)).ok).toBe(false);
    expect((await pow.verify(edit({ signature: 'a'.repeat(64) }), ctx)).ok).toBe(false);
    expect((await pow.verify(edit({ number: Number(solution.number) + 1 }), ctx)).ok).toBe(false);
    expect((await pow.verify(edit({ algorithm: 'SHA-1' }), ctx)).ok).toBe(false);
  });

  it('refuses a solution whose digits were moved into the salt', async () => {
    const t = Date.UTC(2027, 0, 1);
    const pow = createProofOfWorkCaptcha({ hmacKey, challengeUrl: 'https://x.test/c', replay: createMemoryReplayStore({ now: () => t }), maxNumber: 100_000, now: () => t });
    const ctx = { orgId: 'o', formId: 'f' };
    let solution: Record<string, unknown>;
    do solution = JSON.parse(Buffer.from(solveAltcha(pow.challenge(ctx)), 'base64').toString()) as Record<string, unknown>;
    while (!/^[1-9]{3}\d{2}$/.test(String(solution.number)));
    const n = String(solution.number);
    for (const k of [1, 2]) {
      const spliced = { ...solution, salt: `${String(solution.salt)}${n.slice(0, k)}`, number: Number(n.slice(k)) };
      // The hash input and so the signature are unchanged; only the salt's shape gives the edit away.
      expect(createHash('sha256').update(`${spliced.salt}${spliced.number}`).digest('hex')).toBe(solution.challenge);
      expect((await pow.verify(Buffer.from(JSON.stringify(spliced)).toString('base64'), ctx)).ok).toBe(false);
    }
    expect((await pow.verify(Buffer.from(JSON.stringify(solution)).toString('base64'), ctx)).ok).toBe(true);
  });

  it('refuses an expiry further out than one challenge lifetime', async () => {
    const t = Date.UTC(2027, 0, 1);
    const issuer = createProofOfWorkCaptcha({ hmacKey, challengeUrl: 'https://x.test/c', replay: createMemoryReplayStore(), maxNumber: 100, expiresSec: 7200, now: () => t });
    const verifier = createProofOfWorkCaptcha({ hmacKey, challengeUrl: 'https://x.test/c', replay: createMemoryReplayStore(), maxNumber: 100, expiresSec: 600, now: () => t });
    const ctx = { orgId: 'o', formId: 'f' };
    expect((await verifier.verify(solveAltcha(issuer.challenge(ctx)), ctx)).ok).toBe(false);
    expect((await verifier.verify(solveAltcha(verifier.challenge(ctx)), ctx)).ok).toBe(true);
  });

  it('raises the work with the spam score', () => {
    expect(powDifficulty(0)).toBe(50_000);
    expect(powDifficulty(0.6)).toBe(250_000);
    expect(powDifficulty(0.95)).toBe(1_000_000);
    expect(powDifficulty(Number.NaN)).toBe(1_000_000);
    const pow = createProofOfWorkCaptcha({ hmacKey, challengeUrl: 'https://x.test/c', replay: createMemoryReplayStore() });
    expect(pow.challenge({ orgId: 'o', formId: 'f' }, { maxNumber: powDifficulty(0.6) }).maxnumber).toBe(250_000);
    expect(() => pow.challenge({ orgId: 'o', formId: 'f' }, { maxNumber: 0 })).toThrow(/maxNumber/);
    expect(() => createProofOfWorkCaptcha({ hmacKey: new Uint8Array(8), challengeUrl: 'x', replay: createMemoryReplayStore() })).toThrow(/32 bytes/);
  });
});

describe('third-party captcha', () => {
  it('is refused when the edition does not enable the provider (air-gapped: none are)', () => {
    const egress = createEgressGuard({ policy: 'none' });
    expect(() => createThirdPartyCaptcha({ provider: 'turnstile', siteKey: 's', secret: 'x', egress, enabled: [] })).toThrow(/not enabled/);
  });

  it('never calls a provider the egress guard denies', async () => {
    const mock = await startSiteverifyMock();
    try {
      const captcha = createThirdPartyCaptcha({
        provider: 'hcaptcha',
        siteKey: 's',
        secret: mock.secret,
        egress: createEgressGuard({ policy: 'none' }),
        enabled: ['hcaptcha'],
        verifyUrl: mock.url,
      });
      await expectPortError(captcha.verify(mock.issue(), { orgId: 'o', formId: 'f' }), 'egress_denied');
      expect(mock.requests).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  it('does not send the respondent IP and treats a broken secret as an outage', async () => {
    const mock = await startSiteverifyMock();
    try {
      const egress = createEgressGuard({ policy: 'allowlist', allowlist: [`127.0.0.1:${new URL(mock.url).port}`] });
      const ok = createThirdPartyCaptcha({ provider: 'recaptcha_v3', siteKey: 's', secret: mock.secret, egress, enabled: ['recaptcha_v3'], verifyUrl: mock.url });
      expect(await ok.verify(mock.issue({ score: 0.3 }), { orgId: 'o', formId: 'f', ipHash: 'h' })).toEqual({ ok: false, score: 0.3 });
      expect(Object.keys(mock.requests[0] ?? {}).sort()).toEqual(['response', 'secret']);
      const wrong = createThirdPartyCaptcha({ provider: 'recaptcha_v3', siteKey: 's', secret: 'wrong', egress, enabled: ['recaptcha_v3'], verifyUrl: mock.url });
      await expectPortError(wrong.verify(mock.issue({ score: 0.9 }), { orgId: 'o', formId: 'f' }), 'unavailable');
    } finally {
      await mock.close();
    }
  });
});
