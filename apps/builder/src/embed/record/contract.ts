import { flagOf, legacyOfElement, parseDmsDate, type DmsElement } from '@form/registry/profiles/dms-v1';
import type { ErrorCode } from '@/embed/contract';

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

/**
 * What dms-api shows in place of a secret value in a record (`MasterFieldVisibility::SECRET_MASK`, SEC-DESIGN 5): six bullets. It is never
 * a value: a read answers it with a `<name>__masked: true` sibling, and a write that carries it is refused (SECRET_MASK_NOT_ALLOWED).
 */
export const SECRET_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022';
/** The sibling key of a masked cell (`Tax Id__masked: true`). A key with this ending is never written. */
export const MASKED_SUFFIX = '__masked';

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
  /** Values as loaded, by field name. Empty in add mode. A secret is never in it as a value: it is `''`, and its name is in `masked`. */
  values: DmsRecordValues;
  /** Names of the secret fields that hold a stored value DMS did not send (their cell carried the mask and `<name>__masked`). */
  masked: string[];
  /** `can.reveal_fields` of the master answer (may this reader see hidden fields); `null` when DMS did not say. */
  canReveal: boolean | null;
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

/** A field marked secret in the master: its value is write-only (shown as a mask, never read back, never prefilled). */
export const isSecretElement = (el: DmsElement): boolean => flagOf(el.is_secret) === true;

/** A field marked hidden in the master: DMS omits it for a reader who cannot reveal it. */
export const isHiddenElement = (el: DmsElement): boolean => flagOf(el.is_hidden) === true;

/** The secret names of a loaded record: flagged secret by the master, or answered masked by the record. */
export function secretNames(loaded: Pick<LoadedDmsRecord, 'elements' | 'masked'>): Set<string> {
  const names = new Set(loaded.masked);
  for (const el of loaded.elements) if (isSecretElement(el)) names.add(fieldNameOf(el));
  return names;
}

/** The elements a record save may write: not legacy, not auto-increment. */
export const writableElements = (elements: readonly DmsElement[]): DmsElement[] => elements.filter((el) => !isLegacyElement(el) && !isIncrementElement(el));

const MASKED_TRUE = new Set(['true', '1']);

/**
 * `json_data` of a master-records response (a JSON string or an object) as field name -> DMS string, plus the names whose cell was
 * masked. A masked cell (`Tax Id: "\u2022\u2022\u2022\u2022\u2022\u2022", "Tax Id__masked": true`) reads as "has a stored value": its value is `''`, never the
 * mask, and every `__masked` key is dropped from the values.
 */
export function parseRecordCells(raw: unknown): { values: DmsRecordValues; masked: string[] } {
  let data: unknown = raw;
  if (typeof data === 'string') {
    if (data.trim() === '') return { values: {}, masked: [] };
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error('DMS sent a record this page cannot read.');
    }
  }
  // PHP encodes an empty array as `[]`.
  if (data === null || data === undefined || (Array.isArray(data) && data.length === 0)) return { values: {}, masked: [] };
  if (!isRecord(data)) throw new Error('DMS sent a record this page cannot read.');
  const values: DmsRecordValues = {};
  const masked = new Set<string>();
  for (const [name, v] of Object.entries(data)) {
    if (name.endsWith(MASKED_SUFFIX)) {
      if (v === true || (typeof v === 'string' && MASKED_TRUE.has(v.toLowerCase())) || v === 1) masked.add(name.slice(0, -MASKED_SUFFIX.length));
      continue;
    }
    if (typeof v === 'string') values[name] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') values[name] = String(v);
    else if (v === null || v === undefined) values[name] = '';
    else values[name] = JSON.stringify(v);
  }
  // The mask is never a value, with or without its sibling (an older dms-api, a cache).
  for (const [name, v] of Object.entries(values)) {
    if (v === SECRET_MASK) {
      masked.add(name);
      values[name] = '';
    }
  }
  for (const name of masked) values[name] = '';
  return { values, masked: [...masked] };
}

/** `json_data` of a master-records response; returns field name -> DMS string (see `parseRecordCells`). */
export function parseRecordJson(raw: unknown): DmsRecordValues {
  return parseRecordCells(raw).values;
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

/**
 * A secret's value as it may be written, or `undefined` when it must be left out: a blank (the stored value stays) and the mask itself
 * (never a value) are not sent. Everything else is a new value the person typed.
 */
export function secretToWrite(next: string | undefined): string | undefined {
  return next === undefined || next === '' || next === SECRET_MASK ? undefined : next;
}

/** The create body's values: every writable field, `''` when empty; a secret only when the person typed one (never the mask). */
export function createRecordValues(loaded: LoadedDmsRecord, next: DmsRecordValues): DmsRecordValues {
  const secrets = secretNames(loaded);
  const out: DmsRecordValues = {};
  for (const el of writableElements(loaded.elements)) {
    const name = fieldNameOf(el);
    out[name] = secrets.has(name) ? (secretToWrite(next[name]) ?? '') : (next[name] ?? '');
  }
  return out;
}

/**
 * The update body: only changed, non-legacy fields; `null` when nothing changed. A secret is sent only when the person replaced it
 * (typed a new value): an untouched secret is absent, so DMS keeps what it stores, and the mask is never sent.
 */
export function diffRecordValues(loaded: LoadedDmsRecord, next: DmsRecordValues): DmsRecordValues | null {
  const secrets = secretNames(loaded);
  const changed: DmsRecordValues = {};
  for (const el of writableElements(loaded.elements)) {
    const name = fieldNameOf(el);
    if (secrets.has(name)) {
      const typed = secretToWrite(next[name]);
      if (typed !== undefined) changed[name] = typed;
      continue;
    }
    const was = loaded.values[name] ?? '';
    const now = next[name] ?? '';
    if (!sameValue(el, was, now)) changed[name] = now;
  }
  return Object.keys(changed).length === 0 ? null : changed;
}

/**
 * Last line of defence before a body is built: no key ending in `__masked`, and no secret holding the mask. dms-api refuses both
 * (SECRET_MASK_NOT_ALLOWED); this makes sure fORM- never sends them whatever a caller passes.
 */
export function withoutMasked(values: DmsRecordValues, secrets: ReadonlySet<string>): DmsRecordValues {
  const out: DmsRecordValues = {};
  for (const [name, v] of Object.entries(values)) {
    if (name.endsWith(MASKED_SUFFIX)) continue;
    if (secrets.has(name) && v === SECRET_MASK) continue;
    out[name] = v;
  }
  return out;
}

/**
 * `returnUrl` with the outcome appended (`fp_status`, `fp_master_id`, and `fp_record_id` when saved; DESIGN 3.5). `error` carries the
 * `fp_code` of the table and is sent only after a load the page cannot continue from.
 */
export function recordReturnTarget(returnUrl: string, status: 'saved' | 'cancelled' | 'error', masterId: string, recordId?: string, code?: ErrorCode | string): string {
  const url = new URL(returnUrl);
  url.searchParams.set('fp_status', status);
  url.searchParams.set('fp_master_id', masterId);
  if (status === 'saved' && recordId) url.searchParams.set('fp_record_id', recordId);
  if (status === 'error' && code && /^[A-Z_]{1,64}$/.test(code)) url.searchParams.set('fp_code', code);
  return url.toString();
}
