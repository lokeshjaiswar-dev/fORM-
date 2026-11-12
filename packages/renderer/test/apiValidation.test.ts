import { describe, expect, it, vi } from 'vitest';
import type { ApiValidation, SafeUrl } from '@form/schema';
import { buildApiRequest, callFieldApi, matchSuccessRule, parseApiBody, postFieldApi } from '../src/controls/apiValidation.ts';

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

  it('POST puts the field key in the JSON body and sends extra body fields', () => {
    const req = buildApiRequest(
      { url, method: 'POST', body: [{ key: 'source', value: 'builder' }], auth: { type: 'bearer', token: 'secret' } },
      'emp_name',
      'Lokesh',
    );
    expect(req.init.method).toBe('POST');
    expect(req.init.body).toBe(JSON.stringify({ source: 'builder', emp_name: 'Lokesh' }));
    expect((req.init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
  });
});

describe('callFieldApi', () => {
  it('POSTs JSON with the field key and typed value', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(postFieldApi(url, 'emp_name', 'Lokesh')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ emp_name: 'Lokesh' }),
    });
    vi.unstubAllGlobals();
  });

  it('uses the API message when ok is false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, message: 'Name not found' }), { status: 200 })));
    await expect(postFieldApi(url, 'emp_name', 'Nope')).resolves.toEqual({
      ok: false,
      message: 'Name not found',
    });
    vi.unstubAllGlobals();
  });

  it('uses the selected response key and success rule', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));
    const config: ApiValidation = { url, method: 'POST', parser: 'json', responseKey: 'success', success: { type: 'boolean', equals: true } };
    await expect(callFieldApi(config, 'emp_name', 'Lokesh')).resolves.toEqual({ ok: true });
    vi.unstubAllGlobals();
  });

  it('fails when the selected key does not match the success rule', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })));
    const config: ApiValidation = { url, method: 'POST', parser: 'json', responseKey: 'success', success: { type: 'boolean', equals: true } };
    await expect(callFieldApi(config, 'emp_name', 'Lokesh')).resolves.toEqual({ ok: false });
    vi.unstubAllGlobals();
  });
});
