import type { BlockId } from '@form/schema';
import { describe, expect, it } from 'vitest';
import {
  LOOKUP_LIMITS, buildUpstreamRequest, defaultSuccess, filterLookupRows, getAtPath, lookupAnswer, lookupRows, mapApiOptions, matchSuccessRule, parseApiBody, projectLookupRows,
} from '../src/remote/index.ts';

const bid = (v: string) => v as BlockId;
const people = { data: [
  { name: 'Asha Rao', city: 'Pune', phone: '98', secret: 'S1', tax: 'T1' },
  { name: 'ásha Mehta', city: 'Delhi', phone: '99', secret: 'S2' },
  { name: 'Bala', city: 'Goa', secret: 'S3' },
  { name: '', city: 'Nowhere' },
  'junk',
  { name: 'Chitra', city: 'x'.repeat(1500) },
] };
const lookup = { itemsPath: 'data', pickerKey: 'name', mappings: [{ key: 'city', fieldId: bid('f_city') }, { key: 'phone', fieldId: bid('f_phone') }, { key: 'secret' }, { key: 'tax', fieldId: bid('f_gone') }] };
const has = (id: string) => id === 'f_city' || id === 'f_phone';

describe('moved parse, check and options helpers behave as before (parity)', () => {
  it('parses JSON and XML bodies and reads dotted and indexed paths', () => {
    expect(parseApiBody('{"a":{"b":[1,{"c":"x"}]}}', 'json').data).toEqual({ a: { b: [1, { c: 'x' }] } });
    expect(parseApiBody('not json', 'json').data).toBeUndefined();
    expect(parseApiBody('<r><ok>true</ok><n>3</n></r>', 'xml').data).toEqual({ ok: true, n: 3 });
    expect(getAtPath({ a: { b: [1, { c: 'x' }] } }, 'a.b[1].c')).toBe('x');
    expect(getAtPath(null, 'a')).toBeUndefined();
  });

  it('matches success rules and derives a default', () => {
    expect(matchSuccessRule('true', { type: 'boolean', equals: true })).toBe(true);
    expect(matchSuccessRule('3', { type: 'number', equals: 3 })).toBe(true);
    expect(matchSuccessRule(' ok ', { type: 'string', equals: ['ok'] })).toBe(true);
    expect(matchSuccessRule('no', { type: 'string', equals: ['ok'] })).toBe(false);
    expect(defaultSuccess({ key: 'ok', type: 'boolean', value: true })).toEqual({ type: 'boolean', equals: true });
  });

  it('maps options from an array and a map', () => {
    expect(mapApiOptions({ items: [{ id: 'a', n: 'Alpha' }] }, { url: 'https://x.example' as never, itemsPath: 'items', labelKey: 'n', valueKey: 'id' })).toEqual([{ id: 'a', label: 'Alpha' }]);
    expect(mapApiOptions({ m: { x: 'One', y: 'Two' } }, { url: 'https://x.example' as never, itemsPath: 'm', collectionKind: 'map', labelKey: '$self', valueKey: '$key' }).map((o) => o.label)).toEqual(['One', 'Two']);
  });

  it('fills only text-like targets with a number that is a number', () => {
    expect(lookupAnswer('short_text', 'x')).toEqual({ type: 'short_text', value: 'x' });
    expect(lookupAnswer('number', 'abc')).toBeUndefined();
    expect(lookupAnswer('email', 'a@b.c')).toBeUndefined();
  });
});

describe('lookup rows (T-LK-03 unit)', () => {
  it('reads rows under itemsPath and drops junk and empty labels', () => {
    expect(lookupRows(people, lookup).map((r) => r.label)).toEqual(['Asha Rao', 'ásha Mehta', 'Bala', 'Chitra']);
  });

  it('filters by a case-insensitive NFC substring of the label', () => {
    const rows = lookupRows(people, lookup);
    expect(filterLookupRows(rows, 'ASHA').map((r) => r.label)).toEqual(['Asha Rao']);
    expect(filterLookupRows(rows, 'ásha').map((r) => r.label)).toEqual(['ásha Mehta']);
    expect(filterLookupRows(rows, '').length).toBe(rows.length);
    expect(filterLookupRows(rows, 'zzz')).toEqual([]);
  });

  it('projects only the picker key and the mapped keys whose field exists in the version', () => {
    const { rows } = projectLookupRows(people, lookup, { q: '', hasBlock: has });
    expect(rows[0]).toEqual({ label: 'Asha Rao', cells: { name: 'Asha Rao', city: 'Pune', phone: '98' } });
    for (const r of rows) expect(Object.keys(r.cells).every((k) => ['name', 'city', 'phone'].includes(k))).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/S1|S2|S3|T1/);
  });

  it('caps rows at maxRows (default 20, never above 50), reports truncated, and caps label and cell length', () => {
    const many = { data: Array.from({ length: 80 }, (_, i) => ({ name: `Person ${i}`, city: 'x'.repeat(1500) })) };
    const a = projectLookupRows(many, lookup, { q: '', hasBlock: has });
    expect(a.rows).toHaveLength(LOOKUP_LIMITS.defaultRows);
    expect(a.truncated).toBe(true);
    expect(a.rows[0]!.cells['city']!.length).toBe(LOOKUP_LIMITS.cell);
    expect(projectLookupRows(many, { ...lookup, maxRows: 500 }, { q: '', hasBlock: has }).rows).toHaveLength(50);
    expect(projectLookupRows(many, { ...lookup, maxRows: 3 }, { q: '', hasBlock: has })).toMatchObject({ truncated: true, rows: expect.any(Array) });
    expect(projectLookupRows(many, { ...lookup, maxRows: 100 }, { q: '', hasBlock: has, rowCap: 20 }).rows).toHaveLength(20);
    const long = projectLookupRows({ data: [{ name: 'L'.repeat(500) }] }, lookup, { q: '', hasBlock: has });
    expect(long.rows[0]!.label).toHaveLength(LOOKUP_LIMITS.label);
    expect(projectLookupRows(people, lookup, { q: '', hasBlock: has }).truncated).toBe(false);
  });

  it('filters server-side only when no searchParam is set', () => {
    expect(projectLookupRows(people, lookup, { q: 'bala', hasBlock: has }).rows.map((r) => r.label)).toEqual(['Bala']);
    expect(projectLookupRows(people, { ...lookup, searchParam: 'q' }, { q: 'bala', hasBlock: has }).rows).toHaveLength(4);
  });

  it('returns no row when the response is not a list', () => {
    expect(projectLookupRows({ data: { a: 1 } }, lookup, { q: '', hasBlock: has })).toEqual({ rows: [], truncated: false });
    expect(projectLookupRows(undefined, lookup, { q: '', hasBlock: has })).toEqual({ rows: [], truncated: false });
  });
});

describe('the upstream request description is pure and carries no credential', () => {
  const base = { url: 'https://hr.example/api/emp?x=1' as never };
  it('GET puts the search term under searchParam, after the configured query', () => {
    const r = buildUpstreamRequest({ ...base, method: 'GET', query: [{ key: 'tenant', value: 't1' }] }, { key: 'q', value: 'asha' });
    expect(r.method).toBe('GET');
    expect(new URL(r.url).searchParams.get('q')).toBe('asha');
    expect(new URL(r.url).searchParams.get('tenant')).toBe('t1');
    expect(new URL(r.url).searchParams.get('x')).toBe('1');
    expect(r.body).toBeUndefined();
  });
  it('POST sends a JSON body with the term and never an Authorization header, even for legacy auth', () => {
    const r = buildUpstreamRequest({ ...base, body: [{ key: 'k', value: 'v' }], auth: { type: 'bearer', token: 'LEGACY' } }, { key: 'q', value: 'asha' });
    expect(r.method).toBe('POST');
    expect(JSON.parse(r.body!)).toEqual({ k: 'v', q: 'asha' });
    expect(JSON.stringify(r)).not.toContain('LEGACY');
    expect(Object.keys(r.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });
  it('asks for XML only when the parser is xml', () => {
    expect(buildUpstreamRequest({ ...base, parser: 'xml' }).headers['Accept']).toContain('xml');
    expect(buildUpstreamRequest(base).headers['Accept']).toBe('application/json');
  });
});
