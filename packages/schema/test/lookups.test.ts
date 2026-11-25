import { describe, expect, it } from 'vitest';
import * as S from '../src/index.ts';
import { definition, ids } from './fixtures.ts';

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;
const url = 'https://hr.example/api/employees';
const uuid = (n: number) => `b2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const dmsLookup = { id: 'vendor', source: 'dms_master', masterId: 'm-vendors', pickerFieldId: ids.name, pickerKey: uuid(1), mappings: [{ key: uuid(2), fieldId: ids.marketing }] };

describe('server-side lookups: the schema union (contract section 1)', () => {
  it('a lookup with no `source` is still an http lookup, and legacy `auth` still parses (publish refuses it)', () => {
    const def = definition();
    def.lookups = [{ id: 'hr', url, auth: { type: 'bearer', token: 't' } } as S.HttpLookup];
    expect(ok(S.FormDefinitionSchema, def)).toBe(true);
    expect(ok(S.ApiLookupSchema, { url, itemsPath: 'data', pickerKey: 'name' })).toBe(true);
  });

  it('http lookups take credentialRef, searchParam, minChars (0..3) and maxRows (1..50)', () => {
    const base = { id: 'hr', source: 'http', url };
    expect(ok(S.ApiLookupSchema, { ...base, credentialRef: { secretId: '0192f7a2-0000-7000-8000-000000000001' }, searchParam: 'q', minChars: 0, maxRows: 50 })).toBe(true);
    expect(ok(S.ApiLookupSchema, { ...base, minChars: 4 })).toBe(false);
    expect(ok(S.ApiLookupSchema, { ...base, maxRows: 51 })).toBe(false);
    expect(ok(S.ApiLookupSchema, { ...base, maxRows: 0 })).toBe(false);
    expect(ok(S.ApiLookupSchema, { ...base, credentialRef: { secretId: 'x' } })).toBe(false);
    expect(ok(S.ApiLookupSchema, { ...base, credentialRef: { secretId: '0192f7a2-0000-7000-8000-000000000001', extra: 1 } })).toBe(false);
  });

  it('options and checks take credentialRef too', () => {
    expect(ok(S.ApiOptionsSchema, { url, credentialRef: { secretId: '0192f7a2-0000-7000-8000-000000000001' } })).toBe(true);
    expect(ok(S.ApiValidationSchema, { url, credentialRef: { secretId: 'nope' } })).toBe(false);
  });

  it('a dms_master lookup needs its master, picker and uuid keys, caps mappings at 16 and rows at 20', () => {
    expect(ok(S.ApiLookupSchema, dmsLookup)).toBe(true);
    expect(ok(S.ApiLookupSchema, { ...dmsLookup, minChars: 3, maxRows: 20 })).toBe(true);
    expect(ok(S.ApiLookupSchema, { ...dmsLookup, maxRows: 21 })).toBe(false);
    expect(ok(S.ApiLookupSchema, { ...dmsLookup, pickerKey: 'name' })).toBe(false);
    expect(ok(S.ApiLookupSchema, { ...dmsLookup, mappings: [{ key: uuid(2) }] })).toBe(false);
    expect(ok(S.ApiLookupSchema, { ...dmsLookup, mappings: Array.from({ length: 17 }, (_, i) => ({ key: uuid(i), fieldId: ids.name })) })).toBe(false);
    expect(ok(S.ApiLookupSchema, { ...dmsLookup, url })).toBe(false);
    const def = definition();
    def.lookups = [dmsLookup as S.DmsMasterLookup];
    expect(ok(S.FormDefinitionSchema, def)).toBe(true);
  });
});

describe('server-side lookups: the public projection shapes', () => {
  it('PublicLookup is a closed object without any upstream request key', () => {
    const lookup = { id: 'hr', source: 'http', pickerFieldId: ids.name, pickerKey: 'name', mappings: [{ key: 'city', fieldId: ids.marketing }], minChars: 2, maxRows: 20 };
    expect(ok(S.PublicLookupSchema, lookup)).toBe(true);
    for (const leak of [{ url }, { method: 'GET' }, { itemsPath: 'data' }, { searchParam: 'q' }, { credentialRef: { secretId: 'x' } }, { auth: {} }, { query: [] }]) {
      expect(ok(S.PublicLookupSchema, { ...lookup, ...leak }), Object.keys(leak)[0]).toBe(false);
    }
    expect(ok(S.PublicLookupSchema, { ...lookup, source: 'dms_master', masterId: 'm-1' })).toBe(true);
    // The id is what the proxy route's path names: the same pattern.
    expect(ok(S.PublicLookupSchema, { ...lookup, id: 'my lookup' })).toBe(false);
    expect(ok(S.PublicLookupSchema, { ...lookup, id: 'a.b' })).toBe(false);
  });

  it('a public block carries only the remote markers: a url, key or credential is refused', () => {
    expect(ok(S.PublicApiOptionsSchema, { remote: true })).toBe(true);
    expect(ok(S.PublicApiOptionsSchema, { remote: true, url })).toBe(false);
    expect(ok(S.PublicApiOptionsSchema, { url })).toBe(false);
    expect(ok(S.PublicApiValidationSchema, { remote: true, message: 'Not found' })).toBe(true);
    expect(ok(S.PublicApiValidationSchema, { remote: true, responseKey: 'ok' })).toBe(false);
    const block = { ...(definition().blocks[ids.marketing] as object) };
    expect(ok(S.PublicStoredBlockSchema, { ...block, apiOptions: { remote: true } })).toBe(true);
    expect(ok(S.PublicStoredBlockSchema, { ...block, apiOptions: { url } })).toBe(false);
  });

  it('PublicFormDefinition accepts public lookups and refuses a stored lookup', () => {
    const def = definition() as unknown as Record<string, unknown>;
    const publicLookup = { id: 'hr', source: 'http', pickerFieldId: ids.name, pickerKey: 'name', mappings: [], minChars: 2, maxRows: 20 };
    expect(ok(S.PublicFormDefinitionSchema, { ...def, lookups: [publicLookup] })).toBe(true);
    expect(ok(S.PublicFormDefinitionSchema, { ...def, lookups: [{ id: 'hr', url }] })).toBe(false);
    expect(ok(S.PublicFormDefinitionSchema, { ...def, lookup: { id: 'hr', url } })).toBe(false);
  });
});
