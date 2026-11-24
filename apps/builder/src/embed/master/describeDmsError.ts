import { DmsApiError } from '@/embed/dmsClient';

/** What the author reads for an error dms-api sent back. */
export function describeDmsError(e: unknown): string {
  if (e instanceof DmsApiError) {
    if (e.status === 409 && e.code === 'MASTER_CHANGED') return 'Someone else changed this master after you opened it. Reload this page to see their version. Saving now would overwrite it, so nothing was saved.';
    if (e.status === 409 && String(e.code) === '2051') return `A running workflow uses this master, so its fields cannot be added, removed or retyped right now. ${e.message}`;
    if (e.status === 404 && e.code === 'ALREADY_EXISTS') return 'A master with this name already exists. Change the form title and save again.';
    if (e.status === 503 || String(e.code) === '5031') return 'Workflows are not available in DMS right now, so the master could not be saved. Try again in a moment.';
    if (e.status === 403) return 'You do not have permission to save this master.';
    return e.code === null ? e.message : `${e.message} (${e.code})`;
  }
  return e instanceof Error ? e.message : 'The master could not be saved.';
}
