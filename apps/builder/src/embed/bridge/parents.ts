/*
 * Who may frame a fORM- embed child and hand it a MessagePort: the origins listed in `VITE_FP_EMBED_PARENTS` (comma
 * separated, build time). An empty list, or one with no usable entry, means DENY: nobody may frame it. (The `/1` reader
 * used to fall back to "this page's own origin"; an opaque-origin child has no useful own origin, SEC-DESIGN 3.4.)
 * Only http(s) origins without credentials count; wildcards are not supported.
 */

/** The origin of an http(s) URL without credentials, else null. */
export function originOf(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** `VITE_FP_EMBED_PARENTS` as normalised, de-duplicated origins; entries that are not http(s) origins are dropped; none left = `[]` = deny. */
export function parseEmbedParents(raw: unknown): string[] {
  const listed = typeof raw === 'string' ? raw.split(',').map(originOf).filter((o): o is string => o !== null) : [];
  return [...new Set(listed)];
}

/** The allowlist this build was made with. */
export const embedParents = (): string[] => parseEmbedParents((import.meta.env as Record<string, unknown>).VITE_FP_EMBED_PARENTS);
