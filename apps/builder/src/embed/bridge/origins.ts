import { originOf, parseEmbedParents as parseParents } from './parents.ts';

/*
 * Who may frame the upload page and talk to it. The parent names itself in `?fp_parent=<origin>`, which is a claim, not
 * proof: the child accepts it only when it is on the allowlist (`VITE_FP_EMBED_PARENTS`, comma separated origins; unset = deny),
 * and then still checks `event.source` and `event.origin` of every
 * message against it (childTransport.ts). Wildcards are not supported.
 */

export interface EmbedEnv {
  /** This page's origin. */
  origin: string;
  /** Normalised allowlist; empty = no parent is accepted. */
  parents: readonly string[];
  /** `fp_v`, when the parent sent one. */
  version: string | null;
  /**
   * Optional capabilities the parent announced in `?fp_caps=` (comma list; unknown values are ignored). `lookup`: the parent
   * answers `lookup.request`. Without it the child sends no lookup request, so an old parent never sees one (skew-safe).
   */
  caps: readonly EmbedCap[];
}

export const EMBED_CAPS = ['lookup'] as const;
export type EmbedCap = (typeof EMBED_CAPS)[number];

/** `fp_caps` as the known capabilities it names. */
export function parseCaps(search: string): EmbedCap[] {
  const raw = new URLSearchParams(search).get('fp_caps') ?? '';
  const named = raw.split(',').map((c) => c.trim());
  return EMBED_CAPS.filter((cap) => named.includes(cap));
}

/**
 * `VITE_FP_EMBED_PARENTS` as normalised origins; entries that are not http(s) origins are dropped. An empty or unusable list
 * is `[]`, which denies every parent (it used to default to `ownOrigin`; SEC-DESIGN 3.4). `ownOrigin` is kept for callers.
 */
export function parseEmbedParents(raw: unknown, _ownOrigin?: string): string[] {
  return parseParents(raw);
}

export function embedEnv(search: string, ownOrigin: string, rawParents: unknown = (import.meta.env as Record<string, unknown>).VITE_FP_EMBED_PARENTS): EmbedEnv {
  return { origin: ownOrigin, parents: parseEmbedParents(rawParents, ownOrigin), version: new URLSearchParams(search).get('fp_v'), caps: parseCaps(search) };
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
