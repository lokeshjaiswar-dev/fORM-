import { legacyOfElement, parseDmsDate, type DmsElement } from '@form/registry/profiles/dms-v1';

/*
 * v2 contract stub for `/embed/dms-record` (DESIGN-v2 section 4, contract/dms-record.fixtures.json).
 *
 * Record mode adds or edits ONE record of a Forms+ master inside fORM-, with the user's own DMS token, through the same
 * authenticated master-records routes classic uses. Values are DMS strings keyed by FIELD NAME (the classic `value`).
 * Bodies are filled by lane `form-record`.
 */

/** Paths relative to the descriptor `apiBase`. */
export const DMS_RECORD_ROUTES = {
  master: (masterId: string) => `/dms/v1/master/form/${encodeURIComponent(masterId)}`,
  record: (masterId: string, recordId: string) =>
    `/dms/master-records/${encodeURIComponent(recordId)}?master_id=${encodeURIComponent(masterId)}`,
  create: () => '/dms/master-records',
  update: (recordId: string) => `/dms/master-records/${encodeURIComponent(recordId)}`,
} as const;

/** DMS record values: field name -> DMS string (`''` when empty). */
export type DmsRecordValues = Record<string, string>;

export interface DmsRecordCreateBody {
  master_id: string;
  json_data: DmsRecordValues;
}

export interface DmsRecordUpdateBody {
  master_id: string;
  master_record_id: string;
  /** Only the fields whose value changed since load. */
  json_data: DmsRecordValues;
}

export interface LoadedDmsRecord {
  masterId: string;
  masterName: string;
  source: string;
  elements: DmsElement[];
  /** `null` in add mode. */
  recordId: string | null;
  /** Values as loaded, by field name. Empty in add mode. */
  values: DmsRecordValues;
}

export interface DmsRecordRepository {
  load(masterId: string, recordId?: string): Promise<LoadedDmsRecord>;
  /** Creates (no `recordId`) or updates the record; returns the record id. Never sends legacy read-only fields. */
  save(loaded: LoadedDmsRecord, next: DmsRecordValues): Promise<{ recordId: string }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The field name of an element: the key of its value in a record (classic `value`, else `name`, else `label`). */
export function fieldNameOf(el: DmsElement): string {
  for (const v of [el.value, el.name, el.label]) if (typeof v === 'string' && v !== '') return v;
  return '';
}

/** A field converted from OpenForm with no lossless target: shown as stored, never written (`legacy: {from, readOnly: true}`). */
export function isLegacyElement(el: DmsElement): boolean {
  return legacyOfElement(el) !== null;
}

/** An auto-increment text or number field: the server assigns it, so it is shown read-only and never written. */
export function isIncrementElement(el: DmsElement): boolean {
  return el.increment === true && (el.type === 'textinput' || el.type === 'numberinput');
}

/** The elements a record save may write: not legacy, not auto-increment. */
export const writableElements = (elements: readonly DmsElement[]): DmsElement[] => elements.filter((el) => !isLegacyElement(el) && !isIncrementElement(el));

/** `json_data` of a master-records response is a JSON string or an object; returns field name -> DMS string. */
export function parseRecordJson(raw: unknown): DmsRecordValues {
  let data: unknown = raw;
  if (typeof data === 'string') {
    if (data.trim() === '') return {};
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error('DMS sent a record this page cannot read.');
    }
  }
  // PHP encodes an empty array as `[]`.
  if (data === null || data === undefined || (Array.isArray(data) && data.length === 0)) return {};
  if (!isRecord(data)) throw new Error('DMS sent a record this page cannot read.');
  const out: DmsRecordValues = {};
  for (const [name, v] of Object.entries(data)) {
    if (typeof v === 'string') out[name] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[name] = String(v);
    else if (v === null || v === undefined) out[name] = '';
    else out[name] = JSON.stringify(v);
  }
  return out;
}

/** Two DMS strings for one field are the same value; a date is the same date in `DD-MM-YYYY` and `YYYY-MM-DD`. */
function sameValue(el: DmsElement, a: string, b: string): boolean {
  if (a === b) return true;
  if (el.type === 'date') {
    const x = parseDmsDate(a);
    return x !== undefined && x === parseDmsDate(b);
  }
  return false;
}

/** The update body: only changed, non-legacy fields; `null` when nothing changed. */
export function diffRecordValues(loaded: LoadedDmsRecord, next: DmsRecordValues): DmsRecordValues | null {
  const changed: DmsRecordValues = {};
  for (const el of writableElements(loaded.elements)) {
    const name = fieldNameOf(el);
    const was = loaded.values[name] ?? '';
    const now = next[name] ?? '';
    if (!sameValue(el, was, now)) changed[name] = now;
  }
  return Object.keys(changed).length === 0 ? null : changed;
}

/** `returnUrl` with the outcome appended (`fp_status`, `fp_master_id`, and `fp_record_id` when saved). */
export function recordReturnTarget(returnUrl: string, status: 'saved' | 'cancelled', masterId: string, recordId?: string): string {
  const url = new URL(returnUrl);
  url.searchParams.set('fp_status', status);
  url.searchParams.set('fp_master_id', masterId);
  if (status === 'saved' && recordId) url.searchParams.set('fp_record_id', recordId);
  return url.toString();
}
