import type { ApiLookup, BlockId } from '@form/schema';
import { getAtPath } from './apiValidation.ts';

export interface LookupRow {
  index: number;
  label: string;
  cells: Record<string, string>;
}

/** Records under `itemsPath`. Each row keeps string cells for the mapped keys. */
export function lookupRows(data: unknown, lookup: Pick<ApiLookup, 'itemsPath' | 'pickerKey' | 'mappings'>): LookupRow[] {
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

export const LOOKUP_TEXT_TYPES = new Set(['short_text', 'long_text', 'url', 'number']);

export function lookupAnswer(type: string, text: string): { type: string; value: string } | undefined {
  if (!LOOKUP_TEXT_TYPES.has(type)) return undefined;
  if (type === 'number' && !Number.isFinite(Number(text))) return undefined;
  return { type, value: text };
}

export function mappedFieldIds(lookup: ApiLookup | undefined): BlockId[] {
  if (!lookup?.mappings) return [];
  return lookup.mappings.flatMap((m) => (m.fieldId ? [m.fieldId] : []));
}
