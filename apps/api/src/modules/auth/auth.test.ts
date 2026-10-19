import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PortError, type KeyProvider } from '@form/ports';
import { base32Decode, base32Encode, ipHash, randomToken, TOKEN_PATTERN } from './crypto.ts';
import { csrfVerdict } from './csrf.ts';
import { createAuthMailer, createLogMailer } from './mail.ts';
import { hibpBreachCheck, hashPassword, isCommonPassword, passwordProblem, verifyPassword } from './passwords.ts';
import { hashRecoveryCode, newRecoveryCodes, normaliseRecoveryCode, RECOVERY_CODE } from './recovery.ts';
import { openTotpSecret, sealTotpSecret } from './secrets.ts';
import { hotp, otpauthUri, totpStep, verifyTotp } from './totp.ts';
import { DENYLIST_ENTRIES } from './denylist.data.ts';

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 appendix B, SHA-1 secret "12345678901234567890", truncated to 6 digits.
  const secret = new TextEncoder().encode('12345678901234567890');
  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];

  it('matches the RFC test vectors', () => {
    for (const [t, code] of vectors) expect(hotp(secret, totpStep(new Date(t * 1000)))).toBe(code);
  });

  it('accepts one step of drift either way, never a step at or before the last one used', () => {
    const now = new Date(1111111111 * 1000);
    const step = totpStep(now);
    expect(verifyTotp(secret, hotp(secret, step), now, null)).toBe(step);
    expect(verifyTotp(secret, hotp(secret, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(secret, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(secret, hotp(secret, step - 2), now, null)).toBeNull();
    expect(verifyTotp(secret, hotp(secret, step), now, step)).toBeNull();
    expect(verifyTotp(secret, hotp(secret, step + 1), now, step)).toBe(step + 1);
    expect(verifyTotp(secret, ` ${hotp(secret, step).slice(0, 3)} ${hotp(secret, step).slice(3)} `, now, null)).toBe(step);
    expect(verifyTotp(secret, 'abcdef', now, null)).toBeNull();
  });

  it('builds the otpauth URI authenticator apps read', () => {
    const uri = otpauthUri({ issuer: 'fORM-', account: 'a@b.test', secret });
    expect(uri).toBe('otpauth://totp/fORM-%3Aa%40b.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=fORM-&algorithm=SHA1&digits=6&period=30');
  });

  it('round-trips base32', () => {
    for (let i = 0; i < 20; i++) {
      const b = new Uint8Array(randomBytes(i));
      expect(base32Decode(base32Encode(b))).toEqual(b);
    }
    expect(base32Encode(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI');
    expect(() => base32Decode('1!')).toThrow(TypeError);
  });
});

describe('tokens and hashes', () => {
  it('makes 43-character base64url tokens', () => {
    const t = randomToken();
    expect(t).toMatch(TOKEN_PATTERN);
    expect(randomToken()).not.toBe(t);
  });

  it('keys IP hashes by the secret and the UTC day', () => {
    const secret = new Uint8Array(32);
    const day = new Date('2026-10-19T10:00:00Z');
    expect(ipHash(secret, '203.0.113.7', day)).toEqual(ipHash(secret, '203.0.113.7', new Date('2026-10-19T23:59:00Z')));
    expect(ipHash(secret, '203.0.113.7', day)).not.toEqual(ipHash(secret, '203.0.113.7', new Date('2026-10-20T00:00:00Z')));
    expect(ipHash(secret, '203.0.113.7', day)).not.toEqual(ipHash(new Uint8Array(32).fill(1), '203.0.113.7', day));
  });
});

describe('recovery codes', () => {
  it('issues ten distinct codes in groups of four and stores only hashes', () => {
    const { codes, hashes } = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(hashes).toEqual(codes.map(hashRecoveryCode));
    expect(hashes.join()).not.toContain(codes[0]!.slice(0, 4));
  });

  it('accepts codes typed loosely', () => {
    expect(normaliseRecoveryCode('abcd-efgh 0123-oil9')).toBe('ABCDEFGH01230119');
    expect(hashRecoveryCode('ABCD-EFGH-0123-0119')).toBe(hashRecoveryCode('abcd efgh 0123 oil9'));
    expect(RECOVERY_CODE.test(normaliseRecoveryCode('123456'))).toBe(false);
  });
});

describe('passwords', () => {
  it('hashes with argon2id and verifies in constant work for a missing hash', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword(null, 'anything')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('checks the local list of common passwords', () => {
    expect(DENYLIST_ENTRIES).toBeGreaterThan(40_000);
    expect(isCommonPassword('password123')).toBe(true);
    expect(isCommonPassword('PassWord123')).toBe(true);
    expect(isCommonPassword('qwertyuiop')).toBe(true);
    expect(isCommonPassword('violet-anchor-teapot-91')).toBe(false);
  });

  it('applies the policy: length, the address, the list, breaches', async () => {
    const email = 'asha@example.test';
    expect(await passwordProblem('short', { email })).toBe('too_short');
    expect(await passwordProblem('x'.repeat(129), { email })).toBe('too_long');
    expect(await passwordProblem('ASHA@example.test', { email })).toBe('personal');
    expect(await passwordProblem('asha@example', { email: 'asha@example' })).toBe('personal');
    expect(await passwordProblem('iloveyou123', { email })).toBe('common');
    expect(await passwordProblem('violet-anchor-teapot-91', { email })).toBeNull();
    expect(await passwordProblem('violet-anchor-teapot-91', { email, breached: async () => true })).toBe('breached');
    // Eight code points, whatever their UTF-16 length.
    expect(await passwordProblem('🔐🔐🔐🔐🔐🔐🔐🔐', { email })).toBeNull();
  });

  it('asks HIBP with the first five SHA-1 characters only and fails open', async () => {
    const asked: string[] = [];
    // SHA-1("violet-anchor-teapot-91") is not in the answer; SHA-1("P@ssw0rd") = 21BD12DC183F740EE76F27B78EB39C8AD972A757.
    const fetcher = (async (url: string | URL) => {
      asked.push(String(url));
      return new Response('1D2DA4053E34E76F6576ED1DA63134B5E2A:2\r\n0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n', { status: 200 });
    }) as typeof fetch;
    const check = hibpBreachCheck({ fetch: fetcher });
    expect(await check('P@ssw0rd')).toBe(false);
    expect(asked).toEqual(['https://api.pwnedpasswords.com/range/21BD1']);
    const hit = hibpBreachCheck({ fetch: (async () => new Response('2DC183F740EE76F27B78EB39C8AD972A757:52579\n')) as unknown as typeof fetch });
    expect(await hit('P@ssw0rd')).toBe(true);
    const errors: unknown[] = [];
    const down = hibpBreachCheck({ fetch: (async () => new Response('', { status: 503 })) as unknown as typeof fetch, onError: (e) => errors.push(e) });
    expect(await down('P@ssw0rd')).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

/** A KeyProvider stand-in: AES-GCM with the context as AAD, like the keyfile adapter. */
function fakeKeys(): KeyProvider {
  const kek = randomBytes(32);
  return {
    async wrap(dek, ctx) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', kek, iv).setAAD(Buffer.from(ctx.orgId));
      const ct = Buffer.concat([c.update(dek), c.final()]);
      return { wrapped: new Uint8Array(Buffer.concat([iv, c.getAuthTag(), ct])), kekRef: 'fake:1' };
    },
    async unwrap(wrapped, kekRef, ctx) {
      if (kekRef !== 'fake:1') throw new PortError('not_found', kekRef);
      const b = Buffer.from(wrapped);
      const d = createDecipheriv('aes-256-gcm', kek, b.subarray(0, 12)).setAAD(Buffer.from(ctx.orgId));
      d.setAuthTag(b.subarray(12, 28));
      return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()]));
    },
    sign: async () => {
      throw new Error('unused');
    },
    publicKey: async () => {
      throw new Error('unused');
    },
  };
}

describe('TOTP secrets at rest', () => {
  it('seals under a wrapped data key bound to the user', async () => {
    const keys = fakeKeys();
    const secret = new Uint8Array(randomBytes(20));
    const sealed = await sealTotpSecret(keys, 'user-1', secret);
    expect(JSON.stringify(sealed)).not.toContain(Buffer.from(secret).toString('base64url'));
    expect(await openTotpSecret(keys, 'user-1', JSON.parse(JSON.stringify(sealed)))).toEqual(secret);
    await expect(openTotpSecret(keys, 'user-2', sealed)).rejects.toThrow();
    await expect(openTotpSecret(keys, 'user-1', { ...sealed, ct: 'AAAA' })).rejects.toThrow();
    await expect(openTotpSecret(keys, 'user-1', { v: 2 })).rejects.toThrow();
  });
});

describe('CSRF verdict (ADR-0008)', () => {
  const origins = ['https://app.form.example'];
  const v = (headers: Record<string, string>) => csrfVerdict({ headers }, origins);

  it('needs the builder header and Fetch-Metadata from the same origin', () => {
    expect(v({ 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' })).toBe('ok');
    expect(v({ 'sec-fetch-site': 'same-origin' })).toBe('missing_client_header');
    expect(v({ 'x-fr-client': 'other', 'sec-fetch-site': 'same-origin' })).toBe('missing_client_header');
    expect(v({ 'x-fr-client': 'builder' })).toBe('no_fetch_metadata');
    expect(v({ 'x-fr-client': 'builder', 'sec-fetch-site': 'cross-site', origin: 'https://app.form.example' })).toBe('cross_site');
    expect(v({ 'x-fr-client': 'builder', 'sec-fetch-site': 'none' })).toBe('cross_site');
  });

  it('accepts same-site only from the configured builder origin', () => {
    expect(v({ 'x-fr-client': 'builder', 'sec-fetch-site': 'same-site', origin: 'https://app.form.example' })).toBe('ok');
    expect(v({ 'x-fr-client': 'builder', 'sec-fetch-site': 'same-site', origin: 'https://forms.form.example' })).toBe('cross_site');
    expect(v({ 'x-fr-client': 'builder', 'sec-fetch-site': 'same-site' })).toBe('cross_site');
  });
});

describe('auth mail', () => {
  it('sends in the background, logs failures and never the link', async () => {
    const sent: Array<{ subject: string; text: string; to: string }> = [];
    const logged: unknown[] = [];
    const log = { info: (o: unknown) => logged.push(o), warn: (o: unknown) => logged.push(o), error: (o: unknown) => logged.push(o) } as never;
    let fail = false;
    const mail = createAuthMailer({
      mailer: {
        send: async (m) => {
          if (fail) throw new Error('smtp down');
          sent.push({ subject: m.subject, text: m.text, to: m.to[0]!.address });
          return { messageId: '<x@y>', refused: [] };
        },
        verify: async () => ({ ok: true }),
      },
      from: { address: 'no-reply@form.test', name: 'fORM-' },
      log,
    });
    mail.send({ kind: 'magic_link', to: { address: 'a@b.test' }, link: 'https://app.form.test/auth/magic#token=abc' });
    await mail.idle();
    expect(sent).toEqual([{ subject: 'Your sign-in link', to: 'a@b.test', text: expect.stringContaining('https://app.form.test/auth/magic#token=abc') }]);
    fail = true;
    mail.send({ kind: 'password_reset', to: { address: 'a@b.test' }, link: 'https://app.form.test/auth/reset#token=secret' });
    await mail.idle();
    expect(JSON.stringify(logged)).not.toContain('secret');
    expect(logged).toHaveLength(1);

    const lines: unknown[] = [];
    const logMailer = createLogMailer({ info: (o: unknown) => lines.push(o) } as never);
    await logMailer.send({ from: { address: 'x@y.z' }, to: [{ address: 'a@b.test' }], subject: 'Your sign-in link', text: 'https://link#token=secret' });
    expect(JSON.stringify(lines)).not.toMatch(/secret|a@b\.test/);
  });
});
