import { DmsMasterLookupSchema, type BlockId, type DmsMasterLookup, type StoredBlock } from '@form/schema';
import { X_DMS, xDms } from './shared.ts';
import type { DmsElement, FpLookup, ProfileIssue } from './types.ts';

/*
 * `fp_lookup` on a master element <-> a `dms_master` lookup of the definition (server-side lookups, contract section 5).
 * The element is the one source of truth in DMS; the lookup is what the runtime and the guard work with. A declaration this
 * module cannot read is never dropped: it stays in the block's `x-dms` and goes back as it came, with a warning.
 */

export const FP_LOOKUP_KEY = 'fp_lookup';
/** The caps the guard and the child agree on (contract section 1). */
export const DMS_LOOKUP_LIMITS = { lookups: 8, mappings: 16 } as const;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MASTER_ID = /^[A-Za-z0-9-]{1,64}$/;
const FIELD_ID = /^[0-9a-fA-F-]{36}$/;
const KEYS = new Set(['v', 'id', 'master_id', 'label_field_id', 'fill', 'min_chars']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The declaration as a typed value, or why it is not one. Closed: an unknown key makes it invalid, so a newer writer's keys are kept raw, not half-read. */
export function parseFpLookup(raw: unknown): FpLookup | string {
  if (!isRecord(raw)) return 'it is not an object';
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) return `it has an unknown key "${key}"`;
  if (raw.v !== 1) return 'its version is not 1';
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) return 'its id is not 1 to 64 letters, digits, "_" or "-"';
  if (typeof raw.master_id !== 'string' || !MASTER_ID.test(raw.master_id)) return 'its master_id is not a master id';
  if (typeof raw.label_field_id !== 'string' || !FIELD_ID.test(raw.label_field_id)) return 'its label_field_id is not a field id';
  if (!Array.isArray(raw.fill) || raw.fill.length > DMS_LOOKUP_LIMITS.mappings) return `its fill is not a list of at most ${DMS_LOOKUP_LIMITS.mappings}`;
  const fill: FpLookup['fill'] = [];
  for (const f of raw.fill) {
    if (!isRecord(f) || Object.keys(f).some((k) => k !== 'from' && k !== 'to')) return 'a fill entry is not { from, to }';
    if (typeof f.from !== 'string' || !FIELD_ID.test(f.from)) return 'a fill "from" is not a field id';
    if (typeof f.to !== 'string' || f.to === '' || f.to.length > 64) return 'a fill "to" is not a field id';
    fill.push({ from: f.from, to: f.to });
  }
  if (raw.min_chars !== undefined && !(Number.isInteger(raw.min_chars) && (raw.min_chars as number) >= 0 && (raw.min_chars as number) <= 3)) return 'its min_chars is not 0 to 3';
  return { v: 1, id: raw.id, master_id: raw.master_id, label_field_id: raw.label_field_id, fill, ...(raw.min_chars === undefined ? {} : { min_chars: raw.min_chars as number }) };
}

/**
 * Reads every element's `fp_lookup` into `dms_master` lookups. A declaration that is invalid, repeats an id, or fills a field
 * that is not an element of the form is left where it is (in `x-dms`, unchanged) and reported as `fp_lookup_invalid`.
 */
export function readLookups(elements: readonly DmsElement[], blocks: Partial<Record<BlockId, StoredBlock>>, issues: ProfileIssue[] | undefined): DmsMasterLookup[] {
  const out: DmsMasterLookup[] = [];
  const ids = new Set<string>();
  for (const el of elements) {
    if (!Object.hasOwn(el, FP_LOOKUP_KEY)) continue;
    const id = String(el.id) as BlockId;
    const block = blocks[id];
    if (!block || block.type === 'unsupported') continue;
    const fail = (why: string) =>
      issues?.push({ severity: 'warning', code: 'fp_lookup_invalid', path: `/blocks/${id}`, message: `The lookup on "${String(el.name)}" is kept as it is, but not used: ${why}.`, blockId: id });
    const parsed = parseFpLookup(el[FP_LOOKUP_KEY]);
    if (typeof parsed === 'string') {
      fail(parsed);
      continue;
    }
    if (ids.has(parsed.id)) {
      fail(`another lookup already has the id "${parsed.id}"`);
      continue;
    }
    const missing = parsed.fill.find((f) => !Object.hasOwn(blocks, f.to));
    if (missing) {
      fail(`it fills a field that is not in this form`);
      continue;
    }
    const lookup: DmsMasterLookup = {
      id: parsed.id,
      source: 'dms_master',
      enabled: true,
      masterId: parsed.master_id,
      pickerFieldId: id,
      pickerKey: parsed.label_field_id,
      mappings: parsed.fill.map((f) => ({ key: f.from, fieldId: f.to as BlockId })),
      ...(parsed.min_chars === undefined ? {} : { minChars: parsed.min_chars }),
    };
    if (!DmsMasterLookupSchema.safeParse(lookup).success) {
      fail('the definition cannot hold it');
      continue;
    }
    ids.add(parsed.id);
    out.push(lookup);
    // The lookup now carries it: the block keeps no second copy.
    const x = (block as { x?: Record<string, unknown> }).x?.[X_DMS];
    if (isRecord(x)) delete x[FP_LOOKUP_KEY];
  }
  return out;
}

/** The `fp_lookup` of a picker: the enabled `dms_master` lookup of the definition that has this block as its picker (the first, when a bad definition has two). */
export function lookupOfPicker(lookups: readonly unknown[] | undefined, blockId: string): FpLookup | undefined {
  for (const l of lookups ?? []) {
    if (!isRecord(l) || l.source !== 'dms_master' || l.enabled !== true || l.pickerFieldId !== blockId) continue;
    const mappings = Array.isArray(l.mappings) ? (l.mappings as Array<{ key: string; fieldId?: string }>) : [];
    return {
      v: 1,
      id: String(l.id),
      master_id: String(l.masterId),
      label_field_id: String(l.pickerKey),
      fill: mappings.flatMap((m) => (m.fieldId === undefined ? [] : [{ from: m.key, to: m.fieldId }])),
      ...(typeof l.minChars === 'number' ? { min_chars: l.minChars } : {}),
    };
  }
  return undefined;
}

export { xDms };
