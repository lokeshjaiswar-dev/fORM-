import { LOOKUP_TEXT_TYPES } from '@form/schema';
import type { ApiLookup, ApiLookupMapping, BlockId } from '@form/schema';
import { caseFold } from '../text.ts';
import { getAtPath } from './parse.ts';

/** The server decides the projection of a lookup (contract section 3, step 9). */
export const LOOKUP_LIMITS = { label: 200, cell: 1000, defaultRows: 20, maxRows: 50, dmsMaxRows: 20, defaultMinChars: 2 } as const;

export interface LookupRow {
  index: number;
  label: string;
  cells: Record<string, string>;
}

/** What the respondent's source returns: the label and the cells of the keys the lookup declares. */
export interface ProjectedRow { label: string; cells: Record<string, string> }

export interface LookupShape {
  itemsPath?: string | undefined;
  pickerKey?: string | undefined;
  mappings?: ReadonlyArray<Pick<ApiLookupMapping, 'key' | 'fieldId'>> | undefined;
  maxRows?: number | undefined;
  searchParam?: string | undefined;
}

/** Records under `itemsPath`. Each row keeps string cells for the picker key and the mapped keys. */
export function lookupRows(data: unknown, lookup: Pick<LookupShape, 'itemsPath' | 'pickerKey' | 'mappings'>): LookupRow[] {
  const at = lookup.itemsPath ? getAtPath(data, lookup.itemsPath) : data;
  if (!Array.isArray(at)) return [];
  const keys = new Set<string>();
  if (lookup.pickerKey) keys.add(lookup.pickerKey);
  for (const mapping of lookup.mappings ?? []) keys.add(mapping.key);
  return at.flatMap((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const cells: Record<string, string> = {};
    for (const key of keys) {
      const onRow = key.includes('.') ? getAtPath(record, key) : record[key];
      const value = onRow === undefined ? getAtPath(data, key) : onRow;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') cells[key] = String(value);
    }
    const label = lookup.pickerKey ? (cells[lookup.pickerKey] ?? '') : '';
    return [{ index, label, cells }];
  }).filter((row) => row.label !== '');
}

/** Case-insensitive NFC substring match on the label; an empty term keeps every row. */
export function filterLookupRows<R extends { label: string }>(rows: readonly R[], q: string): R[] {
  const needle = caseFold(q.trim());
  if (needle === '') return [...rows];
  return rows.filter((row) => caseFold(row.label).includes(needle));
}

const clip = (text: string, max: number) => (text.length > max ? Array.from(text).slice(0, max).join('') : text);

export interface ProjectOptions {
  q: string;
  /** Does this block exist in the version being served? A mapping to a block that does not is never returned. */
  hasBlock: (blockId: string) => boolean;
  /** Hard ceiling for this source (DMS lookups: 20). Defaults to the http ceiling of 50. */
  rowCap?: number;
}

/**
 * The rows a respondent may see: at most `maxRows` (default 20), with only the picker key and the keys whose mapped field
 * exists in this version, each text capped (label 200, cell 1000). Without a `searchParam` the list is filtered by `q` here.
 */
export function projectLookupRows(data: unknown, lookup: LookupShape, options: ProjectOptions): { rows: ProjectedRow[]; truncated: boolean } {
  const ceiling = Math.min(options.rowCap ?? LOOKUP_LIMITS.maxRows, LOOKUP_LIMITS.maxRows);
  const maxRows = Math.max(1, Math.min(lookup.maxRows ?? LOOKUP_LIMITS.defaultRows, ceiling));
  const declared = new Set<string>();
  if (lookup.pickerKey) declared.add(lookup.pickerKey);
  for (const m of lookup.mappings ?? []) if (m.fieldId !== undefined && options.hasBlock(m.fieldId as BlockId)) declared.add(m.key);
  const all = lookupRows(data, lookup);
  const matched = lookup.searchParam === undefined ? filterLookupRows(all, options.q) : all;
  const rows = matched.slice(0, maxRows).map((row): ProjectedRow => {
    const cells: Record<string, string> = {};
    for (const key of declared) {
      const text = row.cells[key];
      if (text !== undefined) cells[key] = clip(text, LOOKUP_LIMITS.cell);
    }
    return { label: clip(row.label, LOOKUP_LIMITS.label), cells };
  });
  return { rows, truncated: matched.length > maxRows };
}

export { LOOKUP_TEXT_TYPES };

export function lookupAnswer(type: string, text: string): { type: string; value: string } | undefined {
  if (!LOOKUP_TEXT_TYPES.has(type)) return undefined;
  if (type === 'number' && !Number.isFinite(Number(text))) return undefined;
  return { type, value: text };
}

export function mappedFieldIds(lookup: Pick<ApiLookup, 'mappings'> | undefined): BlockId[] {
  if (!lookup?.mappings) return [];
  return lookup.mappings.flatMap((m) => (m.fieldId ? [m.fieldId] : []));
}
