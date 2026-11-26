import { DmsApiError } from '@/embed/dmsClient';
import { errorCodeOf, FP_ERROR_MESSAGES, GENERIC_ERROR_MESSAGE, terminalLoadCodeOf, type TerminalLoadCode } from '@/embed/master/describeDmsError';

export { referenceLine, referenceOf } from '@/embed/master/describeDmsError';

/** The lines of a 422 `errors.json_data` answer (the real routes answer 200 with `success:false`; any status is handled alike). */
function validationLines(e: DmsApiError): string[] {
  const body = e.body as { errors?: { json_data?: unknown } } | null;
  const lines = body?.errors?.json_data;
  return Array.isArray(lines) ? lines.filter((l): l is string => typeof l === 'string' && l !== '') : [];
}

/** A body in the envelope shape of DESIGN 3.4: `success: false` with a `request_id` key. */
const isEnvelope = (body: unknown): boolean => typeof body === 'object' && body !== null && !Array.isArray(body) && (body as { success?: unknown }).success === false && 'request_id' in body;

/**
 * What the person reads for an error dms-api sent: the validation lines of the record (legacy shape), else the contract message of the
 * code (every code of the DESIGN 3.4 table, e.g. SECRET_MASK_NOT_ALLOWED, HIDDEN_FIELD_NOT_WRITABLE, FORBIDDEN_RIGHT), else DMS's own
 * message. A code this build does not know, in the new envelope, reads as the generic text. The reference is `referenceLine(e)`.
 */
export function describeRecordError(e: unknown): string[] {
  if (e instanceof DmsApiError) {
    const text = validationLines(e);
    if (text.length > 0) return text;
    const code = errorCodeOf(e);
    if (code !== null) return [FP_ERROR_MESSAGES[code]];
    if (isEnvelope(e.body)) return [GENERIC_ERROR_MESSAGE];
    if (e.status === 403) return ['You do not have permission to save this record.'];
    return [e.message];
  }
  return [e instanceof Error ? e.message : 'The record could not be saved.'];
}

/** The terminal code of a load error (the page cannot continue; "Back to DMS" returns `fp_status=error&fp_code=`), or null. */
export const terminalCodeOf = (e: unknown): TerminalLoadCode | null => terminalLoadCodeOf(e);
