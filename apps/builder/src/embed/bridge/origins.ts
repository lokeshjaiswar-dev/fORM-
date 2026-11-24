/*
 * Who may frame the upload page and talk to it. The parent names itself in `?fp_parent=<origin>`, which is a claim, not
 * proof: the child accepts it only when it is on the allowlist (`VITE_FP_EMBED_PARENTS`, comma separated origins; unset =
 * this page's own origin, the same-host deployment), and then still checks `event.source` and `event.origin` of every
 * message against it (childTransport.ts). Wildcards are not supported.
 */

export interface EmbedEnv {
  /** This page's origin. */
  origin: string;
  /** Normalised allowlist; never empty. */
  parents: readonly string[];
  /** `fp_v`, when the parent sent one. */
  version: string | null;
}

const originOf = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') return null;
    return url.origin;
  } catch {
    return null;
  }
};

/** `VITE_FP_EMBED_PARENTS` as normalised origins; entries that are not http(s) origins are dropped. */
export function parseEmbedParents(raw: unknown, ownOrigin: string): string[] {
  const listed = typeof raw === 'string' ? raw.split(',').map(originOf).filter((o): o is string => o !== null) : [];
  return [...new Set(listed.length > 0 ? listed : [ownOrigin])];
}

export function embedEnv(search: string, ownOrigin: string, rawParents: unknown = (import.meta.env as Record<string, unknown>).VITE_FP_EMBED_PARENTS): EmbedEnv {
  return { origin: ownOrigin, parents: parseEmbedParents(rawParents, ownOrigin), version: new URLSearchParams(search).get('fp_v') };
}

export type ParentResult = { ok: true; parentOrigin: string } | { ok: false; reason: 'missing' | 'malformed' | 'not_allowed' };

/** The parent origin the query claims, when it is on the allowlist. */
export function resolveParent(search: string, env: Pick<EmbedEnv, 'parents'>): ParentResult {
  const raw = new URLSearchParams(search).get('fp_parent');
  if (raw === null || raw === '') return { ok: false, reason: 'missing' };
  const origin = originOf(raw);
  if (origin === null || origin !== raw.trim().replace(/\/+$/, '')) return { ok: false, reason: 'malformed' };
  return env.parents.includes(origin) ? { ok: true, parentOrigin: origin } : { ok: false, reason: 'not_allowed' };
}
