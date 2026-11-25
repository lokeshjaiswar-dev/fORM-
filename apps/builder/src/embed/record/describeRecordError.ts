import { DmsApiError } from '@/embed/dmsClient';

/** What the person reads for an error dms-api sent: the 422 `errors.json_data` lines, else DMS's own message. */
export function describeRecordError(e: unknown): string[] {
  if (e instanceof DmsApiError) {
    const body = e.body as { errors?: { json_data?: unknown } } | null;
    const lines = body?.errors?.json_data;
    // The real routes answer 200 with success:false (any status is handled alike).
    if (Array.isArray(lines)) {
      const text = lines.filter((l): l is string => typeof l === 'string' && l !== '');
      if (text.length > 0) return text;
    }
    if (e.status === 403) return ['You do not have permission to save this record.'];
    return [e.message];
  }
  return [e instanceof Error ? e.message : 'The record could not be saved.'];
}
