import { beforeEach, describe, expect, it } from 'vitest';
import { forgetInvite, pendingInvite, PENDING_INVITE_MS, rememberInvite } from './pendingInvite';

const TOKEN = 't'.repeat(43);
const KEY = 'fr.pendingInvite';
const T0 = Date.UTC(2026, 10, 15, 9, 0, 0);

beforeEach(() => {
  localStorage.clear();
});

describe('pending invite', () => {
  it('keeps the token for the visitor’s return from sign-in or sign-up', () => {
    rememberInvite(TOKEN, T0);
    expect(pendingInvite(T0)).toBe(TOKEN);
    expect(pendingInvite(T0 + PENDING_INVITE_MS - 1)).toBe(TOKEN);
  });

  it('returns null once the expiry has passed, and drops the token from storage', () => {
    rememberInvite(TOKEN, T0);
    expect(pendingInvite(T0 + PENDING_INVITE_MS)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(pendingInvite(T0)).toBeNull();
  });

  it('does not trust an entry from before expiries existed (the bare token), and drops it', () => {
    localStorage.setItem(KEY, TOKEN);
    expect(pendingInvite(T0)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('ignores an entry of the wrong shape', () => {
    localStorage.setItem(KEY, JSON.stringify({ token: 7, expiresAt: 'soon' }));
    expect(pendingInvite(T0)).toBeNull();
    localStorage.setItem(KEY, 'null');
    expect(pendingInvite(T0)).toBeNull();
  });

  it('forgets on request', () => {
    rememberInvite(TOKEN, T0);
    forgetInvite();
    expect(pendingInvite(T0)).toBeNull();
  });
});
