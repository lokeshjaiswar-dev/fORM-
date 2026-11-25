import { DmsApiError } from '@/embed/dmsClient';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface SchemaSyncFailure {
  /** True: the metadata is committed and only the table is out of line; the next save heals it. */
  saved: boolean;
  masterId: string | null;
  /** The lock token after the failure: the new one when `saved`, the unchanged one otherwise. */
  updatedAt: string | null;
}

/** The detail of a `500 SCHEMA_SYNC_FAILED` (DESIGN.md error table), or `null` for any other error. */
export function schemaSyncOf(e: unknown): SchemaSyncFailure | null {
  if (!(e instanceof DmsApiError) || String(e.code) !== 'SCHEMA_SYNC_FAILED') return null;
  const data = isRecord(e.body) && isRecord(e.body.data) ? e.body.data : {};
  const id = data.master_id;
  return {
    saved: data.saved === true,
    masterId: typeof id === 'string' || typeof id === 'number' ? String(id) : null,
    updatedAt: typeof data.updated_at === 'string' ? data.updated_at : null,
  };
}

/** What the author reads for an error dms-api sent back. */
export function describeDmsError(e: unknown): string {
  if (e instanceof DmsApiError) {
    if (e.code === 'MASTER_NOT_CONVERTED') return 'This master has not been converted to Forms+, so it cannot be saved here. An administrator converts OpenForm masters; classic-built masters are edited in DMS classic.';
    const sync = schemaSyncOf(e);
    if (sync) {
      return sync.saved
        ? 'Your changes were saved, but DMS could not bring the master\'s data table in line with them. Press Save to DMS again to finish; nothing you entered is lost.'
        : 'DMS could not change the master\'s data table, so nothing was saved and the master is as it was. Press Save to DMS to try again.';
    }
    if (e.status === 409 && e.code === 'MASTER_CHANGED') return 'Someone else changed this master after you opened it. Reload this page to see their version. Saving now would overwrite it, so nothing was saved.';
    if (e.status === 409 && String(e.code) === '2051') return `A running workflow uses this master, so its fields cannot be added, removed or retyped right now. ${e.message}`;
    if (e.status === 404 && e.code === 'ALREADY_EXISTS') return 'A master with this name already exists. Change the form title and save again.';
    if (e.status === 503 || String(e.code) === '5031') return 'Workflows are not available in DMS right now, so the master could not be saved. Try again in a moment.';
    if (e.status === 403) return 'You do not have permission to save this master.';
    return e.code === null ? e.message : `${e.message} (${e.code})`;
  }
  return e instanceof Error ? e.message : 'The master could not be saved.';
}
