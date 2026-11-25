import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SafeUrl } from '@form/schema';
import { previewRemoteSource } from '@/components/preview/previewRemoteSource';
import { block, formWith } from '@/test/fixtures';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const URL_ = 'https://hr.example.com/people' as SafeUrl;

function setup(answer: unknown) {
  const calls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return Promise.resolve(json(200, { status: 200, data: answer, truncated: false }));
    }),
  );
  const def = {
    ...formWith([
      block('short_text', 'emp', { key: 'emp' }),
      block('short_text', 'dept', { key: 'dept' }),
      block('single_choice', 'city', { key: 'city', apiOptions: { url: URL_, method: 'GET', itemsPath: '', labelKey: 'n', valueKey: 'n' } }),
      block('short_text', 'tin', { key: 'tin', apiValidation: { url: URL_, method: 'GET', responseKey: 'valid', success: { type: 'boolean', equals: true } } }),
    ]),
    formId: 'f1' as never,
    lookups: [
      { id: 'hr', url: URL_, method: 'GET', enabled: true, itemsPath: 'rows', searchParam: 'q', credentialRef: { secretId: 's1' }, pickerKey: 'name', pickerFieldId: 'emp',
        mappings: [{ key: 'name', fieldId: 'emp' }, { key: 'dept', fieldId: 'dept' }, { key: 'ghost', fieldId: 'nope' }, { key: 'salary' }] },
      { id: 'off', url: URL_, enabled: false, pickerKey: 'name', pickerFieldId: 'emp', mappings: [{ key: 'name', fieldId: 'emp' }] },
    ],
  } as never;
  return { calls, source: previewRemoteSource('o1', def) };
}
const signal = () => new AbortController().signal;

afterEach(() => vi.unstubAllGlobals());

describe('previewRemoteSource (the builder preview goes through the author route)', () => {
  it('a lookup calls the author route with the draft request and projects rows to the declared cells only', async () => {
    const { calls, source } = setup({ rows: [{ name: 'Asha', dept: 'Finance', salary: '99', ghost: 'x' }] });
    const out = await source.lookup('hr', 'as', signal());
    expect(calls[0]?.url).toMatch(/\/v1\/forms\/f1\/remote\/test$/);
    expect(calls[0]?.body).toEqual({ request: { url: URL_, method: 'GET', credentialRef: { secretId: 's1' }, searchParam: 'q' }, q: 'as' });
    expect(out.rows).toEqual([{ label: 'Asha', cells: { name: 'Asha', dept: 'Finance' } }]);
  });

  it('a disabled or unknown lookup makes no call', async () => {
    const { calls, source } = setup({ rows: [] });
    expect((await source.lookup('off', 'as', signal())).rows).toEqual([]);
    expect((await source.lookup('nope', 'as', signal())).rows).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('options map the parsed tree; a check sends the field key and value and applies the pass rule', async () => {
    const options = setup([{ n: 'Pune' }, { n: 'Delhi' }]);
    expect((await options.source.options!('city', signal())).map((o) => o.id)).toEqual(['Pune', 'Delhi']);
    const check = setup({ valid: true });
    expect(await check.source.check!('tin', 'abc', signal())).toEqual({ ok: true });
    expect(check.calls[0]?.body).toMatchObject({ fieldKey: 'tin', value: 'abc' });
    const fail = setup({ valid: false });
    expect(await fail.source.check!('tin', 'abc', signal())).toEqual({ ok: false });
  });
});
