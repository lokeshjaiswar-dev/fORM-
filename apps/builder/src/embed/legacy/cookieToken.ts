/*
 * THE cookie reader. It exists only for the M2 build (VITE_FP_LEGACY_DESCRIPTOR=1, SEC-DESIGN 1.12): a `#fp=` launch has no session
 * credential, so the user's own DMS token is read the way fORM- always did. Nothing outside `embed/legacy/**` may touch a cookie or
 * localStorage (scripts/lint-embed-authority.mjs), and this module is reached only by a dynamic import behind the flag, so a default
 * build does not contain it (T-DMSINT-52, T-DMSINT-55 grep the bundle).
 */

const TOKEN_COOKIES = ['Authorization', 'authorization', 'token', 'access_token'] as const;

function cookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const wanted = encodeURIComponent(name);
  for (const part of document.cookie.split('; ')) {
    const at = part.indexOf('=');
    if ((at >= 0 ? part.slice(0, at) : part) !== wanted) continue;
    try {
      return decodeURIComponent(at >= 0 ? part.slice(at + 1) : '');
    } catch {
      return null;
    }
  }
  return null;
}

/** The DMS user token as the DMS frontends keep it (cookies `Authorization`/`token`/`access_token`, then localStorage `token`). Without the `Bearer ` prefix. */
export function readDmsToken(): string | null {
  const clean = (v: string | null | undefined): string | null => {
    const s = (v ?? '').trim().replace(/^Bearer\s+/i, '').replace(/^["']+|["']+$/g, '').trim();
    return s !== '' && s !== 'undefined' && s !== 'null' ? s : null;
  };
  for (const name of TOKEN_COOKIES) {
    const v = clean(cookie(name));
    if (v) return v;
  }
  try {
    return clean(globalThis.localStorage?.getItem('token'));
  } catch {
    return null;
  }
}
