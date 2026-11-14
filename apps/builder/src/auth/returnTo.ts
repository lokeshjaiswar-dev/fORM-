/*
 * Where to go once the person has signed in: Publish sends someone who is not signed in to the sign-in page, and the
 * form they were building (kept in this browser) is where they should land afterwards. The path survives the pages
 * of the flow (second factor, emailed link) in sessionStorage, which is per tab. Only an address inside the builder
 * is ever followed, so a stored value cannot send the browser anywhere else.
 */

const KEY = 'fr.afterSignIn';
const INSIDE = /^\/(?!\/)[A-Za-z0-9\-._~/]*$/;

export function isLocalPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 200 && INSIDE.test(path) && !path.includes('..') && !path.startsWith('/auth/');
}

export function rememberAfterSignIn(path: string): void {
  if (!isLocalPath(path)) return;
  try {
    globalThis.sessionStorage?.setItem(KEY, path);
  } catch {
    /* Private browsing: the person lands on the forms list instead. */
  }
}

/** The remembered path, once: reading it forgets it. */
export function takeAfterSignIn(): string | null {
  try {
    const path = globalThis.sessionStorage?.getItem(KEY) ?? null;
    globalThis.sessionStorage?.removeItem(KEY);
    return isLocalPath(path) ? path : null;
  } catch {
    return null;
  }
}
