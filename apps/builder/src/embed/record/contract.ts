import type { DmsElement } from '@form/registry/profiles/dms-v1';

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

/** `json_data` of a master-records response is a JSON string or an object; returns field name -> DMS string. */
export function parseRecordJson(raw: unknown): DmsRecordValues {
  void raw;
  throw new Error('dms-record parseRecordJson: not implemented (lane form-record)');
}

/** The update body: only changed, non-legacy fields; `null` when nothing changed. */
export function diffRecordValues(loaded: LoadedDmsRecord, next: DmsRecordValues): DmsRecordValues | null {
  void loaded;
  void next;
  throw new Error('dms-record diffRecordValues: not implemented (lane form-record)');
}
