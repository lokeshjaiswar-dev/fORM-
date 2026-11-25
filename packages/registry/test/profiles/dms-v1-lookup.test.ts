import { describe, expect, it } from 'vitest';
import { FormDefinitionSchema, DmsMasterLookupSchema, type BlockId, type DmsMasterLookup, type FormDefinition } from '@form/schema';
import { checkDmsV1, definitionToElements, elementsToDefinition, type DmsElement, type ProfileIssue } from '../../src/profiles/dms-v1/index.ts';
import fixtures from '../../src/profiles/dms-v1/__fixtures__/dms-fp-lookup.fixtures.json' with { type: 'json' };

const elements = fixtures.elements as DmsElement[];
const opts = { formId: 'form_1', title: 'Orders', locale: 'en-IN' };
const read = (els: DmsElement[], issues?: ProfileIssue[]) => elementsToDefinition(els, { ...opts, ...(issues ? { issues } : {}) });
const lookups = (def: FormDefinition) => (def.lookups ?? []) as DmsMasterLookup[];
const errorCodes = (def: FormDefinition) => checkDmsV1(def).filter((i) => i.severity === 'error').map((i) => i.code);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const A = (n: number) => `a2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('fp_lookup on a DMS master element (F6)', () => {
  it('reads into an enabled dms_master lookup that the schema accepts, and the element carries no fp_lookup in x-dms', () => {
    const def = read(elements);
    expect(lookups(def)).toEqual([fixtures.lookup]);
    expect(DmsMasterLookupSchema.safeParse(lookups(def)[0]).success).toBe(true);
    expect(FormDefinitionSchema.safeParse(def).success).toBe(true);
    expect(JSON.stringify(def.blocks[A(1) as BlockId])).not.toContain('fp_lookup');
    expect(checkDmsV1(def)).toEqual([]);
  });

  it('round trip: elements -> definition -> elements is the identity, also on a second pass', () => {
    const once = definitionToElements(read(elements));
    expect(once).toEqual(elements);
    expect(definitionToElements(read(once))).toEqual(elements);
  });

  it('a form with no fp_lookup has no lookups key and writes none', () => {
    const plain = clone(elements).map(({ fp_lookup: _drop, ...rest }) => rest as DmsElement);
    const def = read(plain);
    expect(def.lookups).toBeUndefined();
    expect(JSON.stringify(definitionToElements(def))).not.toContain('fp_lookup');
  });

  it.each(fixtures.invalid.map((c) => [c.why, c.fp_lookup] as const))('an invalid fp_lookup (%s) is kept raw with a warning and makes no lookup', (_why, bad) => {
    const els = clone(elements);
    els[0]!.fp_lookup = bad;
    const issues: ProfileIssue[] = [];
    const def = read(els, issues);
    expect(def.lookups).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain('fp_lookup_invalid');
    // preserved unchanged on the way back
    expect(definitionToElements(def)[0]!.fp_lookup).toEqual(bad);
  });

  it('two lookups with one id: the second is invalid and kept raw', () => {
    const els = clone(elements);
    els.push({ ...els[1]!, id: A(5), name: 'Other', value: 'Other', label: 'Other', fp_lookup: { ...(els[0]!.fp_lookup as object), fill: [] } });
    const issues: ProfileIssue[] = [];
    const def = read(els, issues);
    expect(lookups(def)).toHaveLength(1);
    expect(issues.some((i) => i.code === 'fp_lookup_invalid')).toBe(true);
  });
});

describe('checkDmsV1: lookups', () => {
  const base = () => read(elements);
  const withLookup = (patch: (l: DmsMasterLookup) => DmsMasterLookup): FormDefinition => {
    const def = base();
    return { ...def, lookups: lookups(def).map(patch) };
  };

  it('http lookups, and the legacy singular lookup, are refused: lookup_http_not_supported', () => {
    const def = { ...base(), lookups: [{ id: 'h', url: 'https://x.example.com/', enabled: true }] } as unknown as FormDefinition;
    expect(errorCodes(def)).toContain('lookup_http_not_supported');
    const legacy = { ...base(), lookups: undefined, lookup: { url: 'https://x.example.com/', enabled: true } } as unknown as FormDefinition;
    expect(errorCodes(legacy)).toContain('lookup_http_not_supported');
  });

  it('the picker must be a text input', () => {
    expect(errorCodes(withLookup((l) => ({ ...l, pickerFieldId: A(77) as BlockId })))).toContain('lookup_picker_invalid');
    const long = elementsToDefinition([{ ...elements[0]!, type: 'multilineinput', fp_lookup: undefined }, ...elements.slice(1)] as DmsElement[], opts);
    expect(errorCodes({ ...long, lookups: [fixtures.lookup as unknown as DmsMasterLookup] })).toContain('lookup_picker_invalid');
  });

  it('a target must be a text, multi-line or number input, not the picker, not an increment or legacy field, and used once', () => {
    const els = clone(elements);
    els[1] = { ...els[1]!, type: 'email' };
    els[2] = { ...els[2]!, increment: true };
    els[3] = { ...els[3]!, legacy: { from: 'files', readOnly: true } };
    const def = read(els);
    expect(def.lookups).toBeDefined();
    const codes = checkDmsV1(def).filter((i) => i.code === 'lookup_target_invalid');
    expect(codes).toHaveLength(3);
    expect(errorCodes(withLookup((l) => ({ ...l, mappings: [{ key: l.mappings[0]!.key, fieldId: l.pickerFieldId }] })))).toContain('lookup_target_invalid');
    expect(errorCodes(withLookup((l) => ({ ...l, mappings: [l.mappings[0]!, { key: l.mappings[1]!.key, fieldId: l.mappings[0]!.fieldId }] })))).toContain('lookup_target_duplicate');
  });

  it('a number input and a multi-line input are allowed targets', () => {
    const els = clone(elements);
    els[1] = { ...els[1]!, type: 'numberinput' };
    els[2] = { ...els[2]!, type: 'multilineinput' };
    expect(errorCodes(read(els))).toEqual([]);
  });

  it('at most 8 lookups and 16 mappings', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...(fixtures.lookup as unknown as DmsMasterLookup), id: `l${i}` }));
    expect(errorCodes({ ...base(), lookups: many })).toContain('lookup_too_many');
    const maps = Array.from({ length: 17 }, () => ({ key: fixtures.lookup.mappings[0]!.key, fieldId: A(2) as BlockId }));
    expect(errorCodes(withLookup((l) => ({ ...l, mappings: maps })))).toContain('lookup_too_many_mappings');
  });

  it('a duplicate lookup id and a source that is not a DMS id are errors', () => {
    const dup = { ...base(), lookups: [fixtures.lookup, fixtures.lookup] as unknown as DmsMasterLookup[] };
    expect(errorCodes(dup)).toContain('lookup_id_duplicate');
    expect(errorCodes(withLookup((l) => ({ ...l, masterId: '../x' })))).toContain('lookup_source_invalid');
  });

  it('settings fp_lookup cannot keep (a name, a row cap, a disabled lookup) warn', () => {
    const codes = (def: FormDefinition) => checkDmsV1(def).filter((i) => i.severity === 'warning').map((i) => i.code);
    expect(codes(withLookup((l) => ({ ...l, maxRows: 5 })))).toContain('lookup_setting_dropped');
    expect(codes(withLookup((l) => ({ ...l, enabled: false })))).toContain('lookup_setting_dropped');
  });
});
