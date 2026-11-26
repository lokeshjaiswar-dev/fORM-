import type { RemoteLookupResult, RemoteSource } from '@form/renderer';
import type { PublicLookup } from '@form/schema';
import type { DmsClient } from '@/embed/dmsClient';
import { DMS_FETCH_ROWS, projectMasterRecords, sourceElementsOf, sourceFieldsOf, sourceMasterPath, type SourceField } from './dmsRows';

/*
 * `/embed/dms-record` and the builder preview: the top-level page holds a session credential, so it asks dms-api for the source
 * master's records itself (`GET master-records?id=&q=&page=1&per_page=`), the way the record load does. The session client maps both
 * reads to the session group (`lookup:read`, DESIGN 3.3) and sends the credential only to the session's API base; dms-api binds `id`
 * to a master the session may read and caps `per_page` at 21 and `q` at 100 characters (SEC 1.6), which is what this file asks for.
 * No fORM- server is called (A15(7)/P-43). The same projection as the bridge path.
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
      // GET masters/{id}: its form_builders carry B's hidden and secret flags (fail closed when one is missing).
      known = client.request('GET', sourceMasterPath(masterId)).then((res) => sourceFieldsOf(sourceElementsOf(res)));
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
