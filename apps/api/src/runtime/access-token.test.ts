import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_SECONDS, issueAccessToken, verifyAccessToken } from './access-token.ts';

const SECRET = new Uint8Array(32).fill(7);
const OTHER_SECRET = new Uint8Array(32).fill(8);
const FORM = '0196a2f0-0000-7000-8000-000000000001';
const OTHER_FORM = '0196a2f0-0000-7000-8000-000000000002';
const VERSION = '0196a2f0-0000-7000-8000-0000000000aa';
const OTHER_VERSION = '0196a2f0-0000-7000-8000-0000000000bb';
const NOW = new Date('2026-11-16T10:00:00.000Z');
const scope = { formId: FORM, versionScope: VERSION };

const IAT = Math.floor(NOW.getTime() / 1000);
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

describe('access tokens', () => {
  it('last two hours', () => {
    const { expiresAt } = issueAccessToken(SECRET, scope, NOW);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(7200);
    expect(expiresAt.toISOString()).toBe('2026-11-16T12:00:00.000Z');
  });

  it('verify for the form and version they were issued for, until the second they expire', () => {
    const { accessToken } = issueAccessToken(SECRET, scope, NOW);
    expect(verifyAccessToken(SECRET, accessToken, scope, NOW)).toEqual({ formId: FORM, versionScope: VERSION, iat: IAT, exp: IAT + 7200 });
    expect(verifyAccessToken(SECRET, accessToken, scope, later(7199))).not.toBeNull();
    expect(verifyAccessToken(SECRET, accessToken, scope, later(7200))).toBeNull();
    expect(verifyAccessToken(SECRET, accessToken, scope, later(86_400))).toBeNull();
  });

  it('fail for another form or another version', () => {
    const { accessToken } = issueAccessToken(SECRET, scope, NOW);
    expect(verifyAccessToken(SECRET, accessToken, { ...scope, formId: OTHER_FORM }, NOW)).toBeNull();
    expect(verifyAccessToken(SECRET, accessToken, { ...scope, versionScope: OTHER_VERSION }, NOW)).toBeNull();
  });

  it('fail under another secret', () => {
    const { accessToken } = issueAccessToken(SECRET, scope, NOW);
    expect(verifyAccessToken(OTHER_SECRET, accessToken, scope, NOW)).toBeNull();
  });

  it('fail when the payload or the signature is altered', () => {
    const { accessToken } = issueAccessToken(SECRET, scope, NOW);
    const [prefix, payload, signature] = accessToken.split('.') as [string, string, string];
    // A payload for another form under the first token's signature.
    const forged = Buffer.from(JSON.stringify({ f: OTHER_FORM, v: VERSION, i: IAT, e: IAT + 7200 })).toString('base64url');
    expect(verifyAccessToken(SECRET, `${prefix}.${forged}.${signature}`, { ...scope, formId: OTHER_FORM }, NOW)).toBeNull();
    // A longer life under the first token's signature.
    const longer = Buffer.from(JSON.stringify({ f: FORM, v: VERSION, i: IAT, e: IAT + 7200 * 100 })).toString('base64url');
    expect(verifyAccessToken(SECRET, `${prefix}.${longer}.${signature}`, scope, later(7300))).toBeNull();
    // One character of the signature.
    const flipped = `${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(verifyAccessToken(SECRET, `${prefix}.${payload}.${flipped}`, scope, NOW)).toBeNull();
  });

  it('fail for anything that is not a token, without throwing', () => {
    for (const junk of ['', '.', '..', 'fr1', 'fr1..', 'fr1.x.y', 'fr2.a.b', 'a.b.c.d', 'x'.repeat(2000), '{"f":"x"}', 'fr1.%%%.%%%']) {
      expect(verifyAccessToken(SECRET, junk, scope, NOW), junk).toBeNull();
    }
    expect(verifyAccessToken(SECRET, undefined as unknown as string, scope, NOW)).toBeNull();
  });

  it('are refused when the claims are not the right types, even under a good signature', () => {
    // Signed the way `issueAccessToken` signs (its own key, over the prefix and the payload), so only the shape is wrong.
    const signed = (claims: unknown) => {
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const key = createHmac('sha256', SECRET).update('fr:access-token:v1').digest();
      return `fr1.${payload}.${createHmac('sha256', key).update(`fr1.${payload}`).digest().toString('base64url')}`;
    };
    expect(verifyAccessToken(SECRET, signed({ f: FORM, v: VERSION, i: IAT, e: IAT + 60 }), scope, NOW)).not.toBeNull();
    for (const claims of [{ f: 5, v: VERSION, i: IAT, e: IAT + 60 }, { f: FORM, v: null, i: IAT, e: IAT + 60 }, { f: FORM, v: VERSION, i: 'x', e: IAT + 60 }, { f: FORM, v: VERSION, i: IAT }, null, [], 'text']) {
      expect(verifyAccessToken(SECRET, signed(claims), scope, NOW), JSON.stringify(claims)).toBeNull();
    }
  });

  it('carry no secret and no personal data: only the form, the version and two instants', () => {
    const { accessToken } = issueAccessToken(SECRET, scope, NOW);
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['e', 'f', 'i', 'v']);
    expect(accessToken).not.toContain(Buffer.from(SECRET).toString('base64url'));
  });
});
