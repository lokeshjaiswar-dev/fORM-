import type { ApiOptions, ApiValidation, FormDefinition, HttpLookup } from '@form/schema';

/**
 * Where a proxy request finds what to call: in THAT version's stored definition, never in anything the respondent sends.
 * Anything that is not an enabled http lookup, or a field with the matching config, is "not found" (REMOTE_NOT_FOUND): a
 * disabled lookup, a dms_master lookup (DMS answers those, never this API), another form's id.
 */

export function findHttpLookup(def: Pick<FormDefinition, 'lookup' | 'lookups'>, lookupId: string): HttpLookup | null {
  const listed = (def.lookups ?? []).find((l) => l.source !== 'dms_master' && l.id === lookupId);
  const candidate = listed ?? (def.lookup && (def.lookup.id ?? 'lookup') === lookupId ? def.lookup : undefined);
  if (!candidate || candidate.source === 'dms_master' || candidate.enabled !== true) return null;
  if (!candidate.pickerFieldId || !candidate.pickerKey || !candidate.url) return null;
  return candidate as HttpLookup;
}

export function findFieldOptions(def: Pick<FormDefinition, 'blocks'>, blockId: string): { key: string; config: ApiOptions } | null {
  const block = (def.blocks as Record<string, { key?: string; apiOptions?: ApiOptions } | undefined>)[blockId];
  return block?.apiOptions && block.key !== undefined ? { key: block.key, config: block.apiOptions } : null;
}

export function findFieldCheck(def: Pick<FormDefinition, 'blocks'>, blockId: string): { key: string; config: ApiValidation } | null {
  const block = (def.blocks as Record<string, { key?: string; apiValidation?: ApiValidation } | undefined>)[blockId];
  return block?.apiValidation && block.key !== undefined ? { key: block.key, config: block.apiValidation } : null;
}
