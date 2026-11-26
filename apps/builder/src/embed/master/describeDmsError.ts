import { ERROR_CODES, type ErrorCode } from '@/embed/contract';
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

/**
 * What the author reads for every code of the DESIGN 3.4 error table: the English message of the contract
 * (`contract/__fixtures__/fp-errors.fixtures.json`, which a test compares with this table row by row). dms-api sends its own `message`
 * too; the page shows this one so the text does not change with the server's wording.
 */
export const FP_ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  FP_ORIGIN_DENIED: 'Forms+ cannot be opened from here.',
  FP_TICKET_CHANNEL_DENIED: 'Forms+ cannot be opened from here.',
  WORKSPACE_FORBIDDEN: 'You are not a member of this workspace.',
  FORBIDDEN_RIGHT: 'You do not have permission to do this.',
  NOT_FOUND: 'This master or record is not available.',
  MASTER_NOT_CONVERTED: 'This master has not been moved to Forms+ yet.',
  MODE_NOT_TICKETED: 'Forms+ could not be opened. Try again, and give the reference to your administrator if it keeps failing.',
  VALIDATION_FAILED: 'Forms+ could not be opened. Try again, and give the reference to your administrator if it keeps failing.',
  FP_TICKET_INVALID: 'This link is no longer valid. Go back to DMS and open the form again.',
  LAUNCH_STORE_UNAVAILABLE: 'Forms+ is temporarily unavailable. Try again in a moment.',
  FP_SESSION_INVALID: 'Your Forms+ session ended. Reconnect to DMS to continue.',
  FP_CONTEXT_MISMATCH: 'Your Forms+ session ended. Reconnect to DMS to continue.',
  FP_SCOPE_DENIED: 'This form cannot do that. Go back to DMS and open it again.',
  FIELD_VISIBILITY_FORBIDDEN: 'Only the master creator, an owner or an administrator can change hidden or secret settings.',
  PRIMARY_CANNOT_BE_HIDDEN: 'The primary field cannot be hidden or secret.',
  FIELD_OMITTED: 'The form no longer lists a field that is stored in DMS. Reload and try again.',
  UNKNOWN_FIELD: 'A field to remove does not exist in this master.',
  REMOVAL_NOT_CONFIRMED: 'Type the field name exactly to confirm removing it.',
  REMOVAL_COUNT_CHANGED: 'More records now hold a value in this field. Confirm the removal again.',
  REMOVAL_INCOMPLETE: 'Nothing was changed. Try again.',
  MASTER_CHANGED: 'This master was changed by someone else. Reload and try again.',
  SECRET_MASK_NOT_ALLOWED: 'A masked secret cannot be saved as a value. Enter the real value or leave the field empty.',
  HIDDEN_FIELD_NOT_WRITABLE: 'This form contains a field that cannot be filled in.',
  MASTER_ID_MISMATCH: 'This form does not belong to this link.',
  LINK_EXPIRED: 'This link has expired. Ask the sender for a new one.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
};

/** The message for a well-formed code the table does not know (a newer server), or for an envelope with no usable code. */
export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Try again, and give the reference to your administrator if it keeps failing.';

const KNOWN = new Set<string>(ERROR_CODES);

/** The code of an error as one of the DESIGN 3.4 table, or `null` (a legacy answer, a code from a newer server, no code). */
export function errorCodeOf(e: unknown): ErrorCode | null {
  return e instanceof DmsApiError && typeof e.code === 'string' && KNOWN.has(e.code) ? (e.code as ErrorCode) : null;
}

/** A body in the new envelope shape (DESIGN 3.4): `success: false` and a `request_id` key. A legacy answer has none. */
function isEnvelope(body: unknown): boolean {
  return isRecord(body) && body.success === false && 'request_id' in body;
}

/** The reference an administrator can look up: the envelope's `request_id`, else the `X-Request-Id` the call sent. Null for an error that did not come from dms-api. */
export function referenceOf(e: unknown): string | null {
  return e instanceof DmsApiError ? e.requestId : null;
}

/** "Reference: <id>" as the error panels print it, or null. */
export function referenceLine(e: unknown): string | null {
  const id = referenceOf(e);
  return id === null || id === '' ? null : `Reference: ${id}`;
}

/**
 * Codes after which the page cannot continue: a load answered one of them, so the person is offered "Back to DMS", which returns
 * `fp_status=error&fp_code=<code>` (DESIGN 3.5). A failed save is never terminal: it stays in the page and can be retried.
 */
export const TERMINAL_LOAD_CODES = ['NOT_FOUND', 'FORBIDDEN_RIGHT', 'FP_SCOPE_DENIED', 'MASTER_NOT_CONVERTED'] as const satisfies readonly ErrorCode[];
export type TerminalLoadCode = (typeof TERMINAL_LOAD_CODES)[number];

/** The terminal code of a load error, or `null` when the person can still do something here. */
export function terminalLoadCodeOf(e: unknown): TerminalLoadCode | null {
  const code = errorCodeOf(e);
  return code !== null && (TERMINAL_LOAD_CODES as readonly string[]).includes(code) ? (code as TerminalLoadCode) : null;
}

/** `409 REMOVAL_COUNT_CHANGED {field_id, actual}`: the field whose count grew and its count now, or `null` for any other error. */
export function removalCountChangedOf(e: unknown): { fieldId: string | null; actual: number | null } | null {
  if (errorCodeOf(e) !== 'REMOVAL_COUNT_CHANGED' || !(e instanceof DmsApiError)) return null;
  const details = isRecord(e.body) && isRecord(e.body.details) ? e.body.details : {};
  const id = details.field_id;
  const actual = details.actual;
  return {
    fieldId: typeof id === 'string' && id !== '' ? id : null,
    actual: typeof actual === 'number' && Number.isInteger(actual) && actual >= 0 ? actual : null,
  };
}

/** What the author reads for an error dms-api sent back. The reference line is separate (`referenceLine`). */
export function describeDmsError(e: unknown): string {
  if (e instanceof DmsApiError) {
    const sync = schemaSyncOf(e);
    if (sync) {
      return sync.saved
        ? 'Your changes were saved, but DMS could not bring the master\'s data table in line with them. Press Save to DMS again to finish; nothing you entered is lost.'
        : 'DMS could not change the master\'s data table, so nothing was saved and the master is as it was. Press Save to DMS to try again.';
    }
    const known = errorCodeOf(e);
    if (known !== null) return FP_ERROR_MESSAGES[known];
    // An envelope with a code this build does not know (a newer server): the generic text, never the server's wording or the raw code.
    if (isEnvelope(e.body)) return GENERIC_ERROR_MESSAGE;
    // The shapes DMS answered before this run (DESIGN 3.4: existing behaviours are not re-coded).
    if (e.status === 409 && String(e.code) === '2051') return `A running workflow uses this master, so its fields cannot be added, removed or retyped right now. ${e.message}`;
    if (e.status === 404 && e.code === 'ALREADY_EXISTS') return 'A master with this name already exists. Change the form title and save again.';
    if (e.status === 503 || String(e.code) === '5031') return 'Workflows are not available in DMS right now, so the master could not be saved. Try again in a moment.';
    if (e.status === 403) return 'You do not have permission to save this master.';
    return e.code === null ? e.message : `${e.message} (${e.code})`;
  }
  return e instanceof Error ? e.message : 'The master could not be saved.';
}
