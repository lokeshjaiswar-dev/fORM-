import { describe, expect, it, vi } from 'vitest';
import type { SafeUrl } from '@form/schema';
import { buildApiRequest, matchSuccessRule, parseApiBody, verifyFieldApis } from '../src/controls/apiValidation.ts';

const url = 'https://hr.example.com/names' as SafeUrl;

describe('parseApiBody', () => {
  it('flattens JSON leaves with type and value', () => {
    const { leaves } = parseApiBody(JSON.stringify({ success: true, code: 1, status: 'validated', nested: { ok: false } }), 'json');
    expect(leaves).toEqual([
      { key: 'success', type: 'boolean', value: true },
      { key: 'code', type: 'number', value: 1 },
      { key: 'status', type: 'string', value: 'validated' },
      { key: 'nested.ok', type: 'boolean', value: false },
    ]);
  });

  it('lists arrays and id-keyed maps as collections', () => {
    expect(parseApiBody(JSON.stringify({ data: { cities: [{ id: 'mum', name: 'Mumbai' }] } }), 'json').collections).toEqual([
      { key: 'data.cities', kind: 'array', length: 1, primitive: false, itemKeys: ['id', 'name'] },
    ]);
    expect(parseApiBody(JSON.stringify({ mum: 'Mumbai', del: 'Delhi' }), 'json').collections).toEqual([
      { key: '', kind: 'map', length: 2, primitive: true, itemKeys: [] },
    ]);
  });

  it('turns repeating XML tags into a list', () => {
    const body = `<?xml version="1.0"?>
<root>
  <cities>
    <city><id>mum</id><name>Mumbai</name></city>
    <city><id>del</id><name>Delhi</name></city>
  </cities>
</root>`;
    const parsed = parseApiBody(body, 'xml');
    expect(parsed.collections).toEqual(expect.arrayContaining([
      { key: 'cities.city', kind: 'array', length: 2, primitive: false, itemKeys: ['id', 'name'] },
    ]));
    expect(parsed.leaves).toEqual(expect.arrayContaining([
      { key: 'cities.city[0].id', type: 'string', value: 'mum' },
      { key: 'cities.city[0].name', type: 'string', value: 'Mumbai' },
    ]));
  });

  it('parses XML and coerces booleans and numbers', () => {
    const { leaves } = parseApiBody('<root><success>true</success><code>1</code><msg>ok</msg></root>', 'xml');
    expect(leaves).toEqual(expect.arrayContaining([
      { key: 'success', type: 'boolean', value: true },
      { key: 'code', type: 'number', value: 1 },
      { key: 'msg', type: 'string', value: 'ok' },
    ]));
  });
});

describe('matchSuccessRule', () => {
  it('matches boolean, number and any of the allowed strings', () => {
    expect(matchSuccessRule(true, { type: 'boolean', equals: true })).toBe(true);
    expect(matchSuccessRule(1, { type: 'number', equals: 1 })).toBe(true);
    expect(matchSuccessRule('validated', { type: 'string', equals: ['correct', 'validated'] })).toBe(true);
    expect(matchSuccessRule('nope', { type: 'string', equals: ['correct'] })).toBe(false);
  });
});

describe('buildApiRequest', () => {
  it('GET puts the field key on the query string', () => {
    const req = buildApiRequest({ url, method: 'GET', query: [{ key: 'src', value: 'form' }] }, 'emp_name', 'Lokesh');
    const parsed = new URL(req.url);
    expect(req.init.method).toBe('GET');
    expect(req.init.body).toBeUndefined();
    expect(parsed.searchParams.get('emp_name')).toBe('Lokesh');
    expect(parsed.searchParams.get('src')).toBe('form');
  });

  it('omits the field answer when no field key is given', () => {
    const req = buildApiRequest({ url, method: 'GET', query: [{ key: 'src', value: 'form' }] });
    const parsed = new URL(req.url);
    expect(parsed.searchParams.get('src')).toBe('form');
    expect([...parsed.searchParams.keys()]).toEqual(['src']);
  });

  it('POST puts the field key in the JSON body and sends extra body fields, never credentials (review B1)', () => {
    const req = buildApiRequest(
      { url, method: 'POST', body: [{ key: 'source', value: 'builder' }], auth: { type: 'bearer', token: 'secret' } },
      'emp_name',
      'Lokesh',
    );
    expect(req.init.method).toBe('POST');
    expect(req.init.body).toBe(JSON.stringify({ source: 'builder', emp_name: 'Lokesh' }));
    expect(req.init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
    for (const auth of [{ type: 'api_key', header: 'X-Key', value: 'k' }, { type: 'basic', username: 'u', password: 'p' }] as const) {
      expect(JSON.stringify(buildApiRequest({ url, method: 'GET', auth }).init)).not.toMatch(/X-Key|Authorization|"k"/);
    }
  });
});

describe('verifyFieldApis sends the scalar the check is about (review: structured answers always failed)', () => {
  const run = async (type: string, value: unknown) => {
    const check = vi.fn(async (_id: string, _v: unknown) => ({ ok: true }));
    const def = { blocks: { f: { id: 'f', key: 'f_key', type, apiValidation: { remote: true } } }, pages: [{ id: 'p1', children: ['f'] }] } as never;
    const errors = await verifyFieldApis(def, { f: { type, value } } as never, new Set(['f']), undefined, 'fallback', { lookup: async () => ({ rows: [], truncated: false }), check });
    return { errors, sent: check.mock.calls[0]?.[1] };
  };

  it('email, phone and choices send a string the proxy accepts (string, number or boolean)', async () => {
    expect(await run('email', { address: 'a@b.in' })).toEqual({ errors: [], sent: 'a@b.in' });
    expect((await run('phone', { e164: '+919800000000', country: 'IN' })).sent).toBe('+919800000000');
    expect((await run('single_choice', { optionId: 'opt_a' })).sent).toBe('opt_a');
    expect((await run('single_choice', { optionId: null, other: 'Something else' })).sent).toBe('Something else');
    expect((await run('multi_choice', { optionIds: ['a', 'b'] })).sent).toBe('["a","b"]');
    expect((await run('datetime', { local: '2026-11-25T10:00', timeZone: 'Asia/Kolkata', instant: '2026-11-25T04:30:00Z' })).sent).toBe('2026-11-25T04:30:00Z');
    expect((await run('time', { start: '09:00', end: '10:00' })).sent).toBe('09:00/10:00');
    expect((await run('date_range', { start: '2026-11-01', end: '2026-11-05' })).sent).toBe('2026-11-01/2026-11-05');
    expect((await run('full_name', { first: 'Asha', last: 'Rao' })).sent).toBe('{"first":"Asha","last":"Rao"}');
    expect((await run('short_text', 'Lokesh')).sent).toBe('Lokesh');
    for (const type of ['email', 'phone', 'single_choice', 'multi_choice', 'datetime', 'time', 'date_range', 'full_name', 'address']) {
      const { sent } = await run(type, type === 'email' ? { address: 'x@y.in' } : { optionIds: ['a'], start: '09:00', end: '10:00', instant: '2026-11-25T04:30:00Z', e164: '+91', optionId: 'a', line1: 'x' });
      expect(['string', 'number', 'boolean'], type).toContain(typeof sent);
    }
  });
});

describe('verifyFieldApis', () => {
  const block = (extra: Record<string, unknown> = {}) => ({ id: 'emp', key: 'emp_name', type: 'short_text', apiValidation: { remote: true }, ...extra });
  const def = (b: unknown) => ({ blocks: { emp: b }, pages: [{ id: 'p1', children: ['emp'] }] }) as never;
  const answers = { emp: { type: 'short_text', value: 'Lokesh' } } as never;
  const visible = new Set(['emp']);

  it('asks the host source (never the network) and keeps the author\'s message for a failed check', async () => {
    const check = vi.fn(async () => ({ ok: false }));
    const errors = await verifyFieldApis(def(block({ messages: { api_failed: 'Name not found' } })), answers, visible, undefined, 'fallback', { lookup: async () => ({ rows: [], truncated: false }), check });
    expect(errors).toEqual([{ blockId: 'emp', code: 'api_failed', message: 'Name not found' }]);
    expect(check).toHaveBeenCalledWith('emp', 'Lokesh', expect.any(AbortSignal));
  });

  it('passes a check that says ok, falls back to the system message, and blocks a check that could not run', async () => {
    const source = (check: () => Promise<{ ok: boolean }>) => ({ lookup: async () => ({ rows: [], truncated: false }), check });
    expect(await verifyFieldApis(def(block()), answers, visible, undefined, 'fallback', source(async () => ({ ok: true })))).toEqual([]);
    expect(await verifyFieldApis(def(block()), answers, visible, undefined, 'fallback', source(async () => ({ ok: false })))).toEqual([{ blockId: 'emp', code: 'api_failed', message: 'fallback' }]);
    expect(await verifyFieldApis(def(block()), answers, visible, undefined, 'fallback', source(async () => { throw new Error('502'); }))).toEqual([{ blockId: 'emp', code: 'api_failed', message: 'fallback' }]);
  });

  it('is inert without a source, or with a source that has no check, and skips empty and hidden fields', async () => {
    expect(await verifyFieldApis(def(block()), answers, visible, undefined, 'fallback')).toEqual([]);
    expect(await verifyFieldApis(def(block()), answers, visible, undefined, 'fallback', { lookup: async () => ({ rows: [], truncated: false }) })).toEqual([]);
    const check = vi.fn(async () => ({ ok: false }));
    const source = { lookup: async () => ({ rows: [], truncated: false }), check };
    expect(await verifyFieldApis(def(block()), {} as never, visible, undefined, 'fallback', source)).toEqual([]);
    expect(await verifyFieldApis(def(block()), answers, new Set(), undefined, 'fallback', source)).toEqual([]);
    expect(check).not.toHaveBeenCalled();
  });
});
