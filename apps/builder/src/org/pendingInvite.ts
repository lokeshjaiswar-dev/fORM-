/*
 * An invite link opened while signed out: the token waits here through sign-in or sign-up (whose email link may open
 * in another tab), and the invite page picks it up afterwards. The link only works for the invited address.
 *
 * It waits for a limited time (BL-235): the token is a credential for one address, so it must not stay readable on a
 * shared device for days. An hour is long enough to read a verification email and come back.
 */

const KEY = 'fr.pendingInvite';

export const PENDING_INVITE_MS = 60 * 60 * 1000;

/** `now` is the clock, in milliseconds since the epoch (a parameter so a test can move it). */
export function rememberInvite(token: string, now: number = Date.now()): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ token, expiresAt: now + PENDING_INVITE_MS }));
  } catch {
    /* Storage unavailable: the visitor opens the link again after signing in. */
  }
}

/** The token that is waiting, or null: none was kept, it expired, or it is an older entry that carries no expiry. */
export function pendingInvite(now: number = Date.now()): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw === null || raw === undefined) return null;
    const kept = readEntry(raw);
    if (kept && now < kept.expiresAt) return kept.token;
    forgetInvite();
    return null;
  } catch {
    return null;
  }
}

export function forgetInvite(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* Nothing to forget. */
  }
}

function readEntry(raw: string): { token: string; expiresAt: number } | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object') return null;
    const { token, expiresAt } = value as { token?: unknown; expiresAt?: unknown };
    return typeof token === 'string' && token !== '' && typeof expiresAt === 'number' ? { token, expiresAt } : null;
  } catch {
    // Before BL-235 the key held the bare token, with no expiry: it is not trusted, and is dropped.
    return null;
  }
}
