/*
 * An invite link opened while signed out: the token waits here through sign-in or sign-up (whose email link may open
 * in another tab), and the invite page picks it up afterwards. The link only works for the invited address.
 */

const KEY = 'fr.pendingInvite';

export function rememberInvite(token: string): void {
  try {
    globalThis.localStorage?.setItem(KEY, token);
  } catch {
    /* Storage unavailable: the visitor opens the link again after signing in. */
  }
}

export function pendingInvite(): string | null {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
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
