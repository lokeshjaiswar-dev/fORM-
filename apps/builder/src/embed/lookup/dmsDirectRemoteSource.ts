import type { RemoteLookupResult, RemoteSource } from '@form/renderer';
import type { PublicLookup } from '@form/schema';
import type { DmsClient } from '@/embed/dmsClient';
import { DMS_RECORD_ROUTES } from '@/embed/record/contract';
import { DMS_FETCH_ROWS, projectMasterRecords, sourceFieldsOf, type SourceField } from './dmsRows';

/*
 * `/embed/dms-record`: the top-level page has the user's own DMS token, so it asks dms-api for the source master's records
 * itself (`GET master-records?id=&q=&page=1&per_page=`), the way the record load does. The token goes only to the launch's
 * `apiBase` (dmsClient), and no fORM- server is called (A15(7)/P-43). The same projection as the bridge path.
 */

const MAX_QUERY = 100;
const EMPTY: RemoteLookupResult = { rows: [], truncated: false };

export function masterRecordsPath(masterId: string, q: string): string {
  return `/dms/master-records?id=${encodeURIComponent(masterId)}&q=${encodeURIComponent(q.slice(0, MAX_QUERY))}&page=1&per_page=${DMS_FETCH_ROWS}`;
}

/** `lookups` are the public lookups of the form (only `dms_master` ones are answered); `client` is the dmsClient of the launch. */
export function dmsDirectRemoteSource(client: Pick<DmsClient, 'request'>, lookups: readonly PublicLookup[]): RemoteSource {
  const declared = new Map(lookups.filter((l) => l.source === 'dms_master' && l.masterId !== undefined).map((l) => [l.id, l]));
  /** B's fields per master, loaded once per page view. */
  const sources = new Map<string, Promise<Map<string, SourceField>>>();
  const fieldsOf = (masterId: string) => {
    let known = sources.get(masterId);
    if (!known) {
      known = client.request<{ data?: { form_builder_fields?: unknown } }>('GET', DMS_RECORD_ROUTES.master(masterId)).then((res) => {
        let list: unknown = res?.data?.form_builder_fields;
        if (typeof list === 'string') {
          try {
            list = JSON.parse(list);
          } catch {
            list = [];
          }
        }
        return sourceFieldsOf(list);
      });
      known.catch(() => sources.delete(masterId));
      sources.set(masterId, known);
    }
    return known;
  };
  return {
    async lookup(lookupId, q, signal) {
      const lookup = declared.get(lookupId);
      if (!lookup?.masterId) return EMPTY;
      const [fields, response] = await Promise.all([fieldsOf(lookup.masterId), client.request('GET', masterRecordsPath(lookup.masterId, q))]);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return projectMasterRecords(response, lookup, fields, lookup.maxRows);
    },
  };
}
