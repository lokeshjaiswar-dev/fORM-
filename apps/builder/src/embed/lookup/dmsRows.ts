import { LOOKUP_LIMITS } from '@form/logic';
import type { RemoteLookupResult } from '@form/renderer';

/*
 * Rows of a source master B for a lookup, from a `master-records` answer (server-side lookups, contract sections 5 and 6).
 * The ONE place where DMS data becomes cells, shared by the bridge path (the parent's answer arrives already projected, and
 * the child applies the same drops again) and the direct path of `/embed/dms-record`. A cell can only be the label column or
 * one of the declared fill columns. Never a cell: a field flagged `is_secret` or `is_hidden`, a value equal to the mask, a
 * key that has a `<name>__masked` sibling, or a row with no label.
 */

/** What DMS puts in place of a secret value. */
export const SECRET_MASK = '••••••';

/** The part of a lookup this module needs: the label column and the filled columns, as DMS field ids of the source master. */
export interface DmsLookupColumns {
  pickerKey: string;
  mappings: ReadonlyArray<{ key: string }>;
}

export interface SourceField {
  name: string;
  secret: boolean;
  hidden: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const flag = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

/**
 * B's elements as id -> name and flags. Elements from `GET master/form/{id}` carry the field name in `value` (else `name`);
 * a field that is flagged secret or hidden is never read. A field that carries no flag is read: DMS itself masks secrets
 * and omits hidden fields in `master-records` for a user who may not see them, and the mask and `__masked` drops below
 * back that up.
 */
export function sourceFieldsOf(elements: unknown): Map<string, SourceField> {
  const out = new Map<string, SourceField>();
  for (const e of Array.isArray(elements) ? elements : []) {
    if (!isObj(e) || typeof e.id !== 'string') continue;
    const name = typeof e.value === 'string' && e.value !== '' ? e.value : typeof e.name === 'string' ? e.name : '';
    if (name === '') continue;
    out.set(e.id.toLowerCase(), { name, secret: flag(e.is_secret), hidden: flag(e.is_hidden) });
  }
  return out;
}

/** The matched-record count when the response states one (ES `total_items`, else `total`). */
function totalOf(res: unknown): number | null {
  const r = res as { data?: Record<string, unknown>; total_items?: unknown; total?: unknown } | null;
  for (const c of [r?.data?.total_items, r?.total_items, r?.data?.total, r?.total]) if (typeof c === 'number' && Number.isFinite(c)) return c;
  return null;
}

function recordList(res: unknown): unknown[] {
  const r = res as { data?: unknown; records?: unknown } | null;
  const inner = isObj(r?.data) ? (r.data as { records?: unknown; data?: unknown }) : undefined;
  for (const c of [inner?.records, r?.records, inner?.data, r?.data, res]) if (Array.isArray(c)) return c;
  return [];
}

function recordData(rec: unknown): Record<string, unknown> | null {
  if (!isObj(rec)) return null;
  let j: unknown = rec.json_data;
  if (typeof j === 'string') {
    try {
      j = JSON.parse(j);
    } catch {
      return null;
    }
  }
  return isObj(j) ? j : null;
}

const cellText = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

/** Records matched by `master-records`: one more than a result holds, so a cut list is detectable. */
export const DMS_FETCH_ROWS = LOOKUP_LIMITS.dmsMaxRows + 1;

/**
 * A `master-records` answer as lookup rows, cells keyed by the source master's field ids. `truncated` is set when more
 * usable rows arrived than a result holds, or the response's total says more records matched.
 */
export function projectMasterRecords(response: unknown, lookup: DmsLookupColumns, fields: ReadonlyMap<string, SourceField>, maxRows: number = LOOKUP_LIMITS.dmsMaxRows): RemoteLookupResult {
  const cap = Math.max(1, Math.min(maxRows, LOOKUP_LIMITS.dmsMaxRows));
  const usable = new Map<string, string>();
  for (const id of new Set([lookup.pickerKey, ...lookup.mappings.map((m) => m.key)])) {
    const f = fields.get(id.toLowerCase());
    if (f && !f.secret && !f.hidden) usable.set(id, f.name);
  }
  const labelName = usable.get(lookup.pickerKey);
  if (labelName === undefined) return { rows: [], truncated: false };
  const list = recordList(response);
  const rows: RemoteLookupResult['rows'] = [];
  for (const rec of list) {
    const data = recordData(rec);
    if (!data) continue;
    const take = (id: string): string | null => {
      const name = usable.get(id);
      if (name === undefined || `${name}__masked` in data) return null;
      const text = cellText(data[name]);
      if (text === null || text === SECRET_MASK) return null;
      return text.slice(0, LOOKUP_LIMITS.cell);
    };
    const label = (take(lookup.pickerKey) ?? '').trim().slice(0, LOOKUP_LIMITS.label);
    if (label === '') continue;
    const cells: Record<string, string> = {};
    for (const id of usable.keys()) {
      const text = take(id);
      if (text !== null) cells[id] = text;
    }
    if (rows.length >= cap) return { rows, truncated: true };
    rows.push({ label, cells });
  }
  const total = totalOf(response);
  return { rows, truncated: total !== null && total > list.length };
}
