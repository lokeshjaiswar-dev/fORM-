import type { ChoiceOption } from '@form/schema';

/*
 * The renderer's only door to the network (server-side lookups, contract section 4). The host passes a source: the public
 * page the fORM- proxy, the builder preview the author test route, the DMS upload iframe the fp-bridge. With no source,
 * lookups, API options and API checks are inert. The renderer itself contains no `fetch` or XMLHttpRequest.
 */
export interface RemoteLookupRow { label: string; cells: Record<string, string> }
export interface RemoteLookupResult { rows: RemoteLookupRow[]; truncated: boolean }

export interface RemoteSource {
  lookup(lookupId: string, q: string, signal: AbortSignal): Promise<RemoteLookupResult>;
  options?(blockId: string, signal: AbortSignal): Promise<ChoiceOption[]>;
  check?(blockId: string, value: unknown, signal: AbortSignal): Promise<{ ok: boolean }>;
}
