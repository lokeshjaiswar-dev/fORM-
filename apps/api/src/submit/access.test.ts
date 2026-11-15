import { describe, expect, it } from 'vitest';
import { issueAccessToken } from '../runtime/access-token.ts';
import { isUnlocked } from './access.ts';

const SECRET = new Uint8Array(32).fill(7);
const FORM = '0196a2f0-0000-7000-8000-000000000001';
const VERSION = '0196a2f0-0000-7000-8000-0000000000aa';
const scope = { formId: FORM, versionScope: VERSION };
const ISSUED = new Date('2026-11-16T10:00:00.250Z');
const at = (seconds: number, base = ISSUED) => new Date(base.getTime() + seconds * 1000);

describe('isUnlocked', () => {
  const { accessToken } = issueAccessToken(SECRET, scope, ISSUED);
  const rules = (passwordUpdatedAt: Date | null) => ({ hasPassword: passwordUpdatedAt !== null, passwordUpdatedAt });

  it('accepts a token issued after the password was set, and none for a form without a password', () => {
    expect(isUnlocked(SECRET, rules(at(-3600)), accessToken, scope, ISSUED)).toBe(true);
    expect(isUnlocked(SECRET, rules(null), accessToken, scope, ISSUED)).toBe(false);
    expect(isUnlocked(SECRET, rules(at(-3600)), undefined, scope, ISSUED)).toBe(false);
  });

  it('refuses a token issued before the last password change, while it has not expired', () => {
    // The password changed 2 s after the unlock: the token is genuine and has 2 h to live, but belongs to the old password.
    expect(isUnlocked(SECRET, rules(at(2)), accessToken, scope, at(3))).toBe(false);
    // A token issued after the change is fine (the new password was given for it).
    const fresh = issueAccessToken(SECRET, scope, at(4)).accessToken;
    expect(isUnlocked(SECRET, rules(at(2)), fresh, scope, at(5))).toBe(true);
  });

  it('compares whole seconds: a token from the second of the change counts as issued after it', () => {
    // iat is floor(10:00:00.250) = 10:00:00; a change at 10:00:00.900 is in the same second.
    expect(isUnlocked(SECRET, rules(new Date('2026-11-16T10:00:00.900Z')), accessToken, scope, ISSUED)).toBe(true);
    expect(isUnlocked(SECRET, rules(new Date('2026-11-16T10:00:01.000Z')), accessToken, scope, ISSUED)).toBe(false);
  });

  it('still refuses a token for another form, another version or one that has expired', () => {
    const old = rules(at(-3600));
    expect(isUnlocked(SECRET, old, accessToken, { ...scope, formId: '0196a2f0-0000-7000-8000-000000000002' }, ISSUED)).toBe(false);
    expect(isUnlocked(SECRET, old, accessToken, { ...scope, versionScope: '0196a2f0-0000-7000-8000-0000000000bb' }, ISSUED)).toBe(false);
    expect(isUnlocked(SECRET, old, accessToken, scope, at(7200))).toBe(false);
  });
});
