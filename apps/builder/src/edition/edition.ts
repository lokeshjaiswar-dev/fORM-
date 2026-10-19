import { create } from 'zustand';
import { RESTRICTED_EDITION, editionSummarySchema, type EditionSummary } from '@form/config';

/*
 * The deployment's edition (FND-19), from `GET /v1/meta/edition`. The last answer is kept in this browser, so an offline
 * reload still knows it. Until any answer exists the builder assumes RESTRICTED_EDITION: it hides what an air-gapped
 * install cannot run rather than offer something the server would refuse at publish.
 */

export type EditionSource = 'server' | 'cached' | 'unknown';

export interface EditionState {
  summary: EditionSummary | null;
  source: EditionSource;
}

export const EDITION_PATH = '/v1/meta/edition';
export const EDITION_CACHE_KEY = 'fr.edition';

/** The API origin when it is not the builder's own (SaaS: `https://api.form.example`); empty means same origin. */
export const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') ?? '';

export const useEditionStore = create<EditionState>(() => ({ summary: null, source: 'unknown' }));

/** The edition feature checks read; RESTRICTED_EDITION while it is unknown. */
export const useEdition = (): EditionSummary => useEditionStore((s) => s.summary ?? RESTRICTED_EDITION);

function readCache(): EditionSummary | null {
  try {
    const raw = globalThis.localStorage?.getItem(EDITION_CACHE_KEY);
    if (!raw) return null;
    const parsed = editionSummarySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeCache(summary: EditionSummary): void {
  try {
    globalThis.localStorage?.setItem(EDITION_CACHE_KEY, JSON.stringify(summary));
  } catch {
    /* Storage blocked or full: the edition is fetched again next time. */
  }
}

/** The server's edition summary, or null when it cannot be read (offline, no API, an unexpected answer). */
export async function fetchEdition(fetcher: typeof fetch = fetch, base = API_BASE): Promise<EditionSummary | null> {
  try {
    const res = await fetcher(`${base}${EDITION_PATH}`, { headers: { accept: 'application/json' } });
    if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) return null;
    const parsed = editionSummarySchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Shows the cached edition at once, then the server's when it answers. */
export async function loadEdition(fetcher?: typeof fetch): Promise<void> {
  const cached = readCache();
  if (cached) useEditionStore.setState({ summary: cached, source: 'cached' });
  const fresh = await fetchEdition(fetcher);
  if (!fresh) return;
  writeCache(fresh);
  useEditionStore.setState({ summary: fresh, source: 'server' });
}
