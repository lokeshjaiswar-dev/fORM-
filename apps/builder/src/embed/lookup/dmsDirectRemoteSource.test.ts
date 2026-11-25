import { describe, expect, it, vi } from 'vitest';
import type { PublicLookup } from '@form/schema';
import { createDmsClient } from '@/embed/dmsClient';
import { fixtures } from '../bridge/fixtures.ts';
import { dmsDirectRemoteSource, masterRecordsPath } from './dmsDirectRemoteSource.ts';

const fx = fixtures.lookup;
const fp = fx.pickerElement.fp_lookup;
const lookup: PublicLookup = {
  id: fp.id,
  source: 'dms_master',
  masterId: fp.master_id,
  pickerFieldId: fx.pickerElement.id as never,
  pickerKey: fp.label_field_id,
  mappings: fp.fill.map((f) => ({ key: f.from, fieldId: f.to as never })),
  minChars: 2,
  maxRows: 20,
};
const TOKEN = 'tok-sentinel-7a1c';
const BASE = 'https://dms.example.test';
/** B's elements as GET masters/{id} returns them: both flags on every field. */
const flagged = fx.sourceMasterElements.map((e) => ({ ...e, is_hidden: Boolean(e.is_hidden), is_secret: Boolean(e.is_secret) }));
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function setup(o: { elements?: unknown[]; records?: unknown; lookups?: PublicLookup[] } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const doFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return url.includes('/dms/masters/') ? ok({ data: { id: fp.master_id, form_builders: o.elements ?? flagged } }) : ok(o.records ?? fx.masterRecordsResponse);
  });
  const client = createDmsClient({ apiBase: BASE, tenantId: 't1', workspaceId: 'w1', fetch: doFetch as never, token: () => TOKEN });
  return { calls, source: dmsDirectRemoteSource(client, o.lookups ?? [lookup]) };
}
const signal = () => new AbortController().signal;

describe('dmsDirectRemoteSource (/embed/dms-record)', () => {
  it('asks master-records as the user: one search per call, page 1, 21 rows, the term encoded and capped', async () => {
    const { calls, source } = setup();
    const out = await source.lookup(lookup.id, 'acm & co', signal());
    const search = calls.find((c) => c.url.includes('/dms/master-records'))!;
    expect(search.url).toBe(`${BASE}/dms/master-records?id=${fp.master_id}&q=acm%20%26%20co&page=1&per_page=21`);
    expect(out.rows.map((r) => r.label)).toEqual(['Acme Traders', 'Acme Foods']);
    expect(masterRecordsPath('m1', 'x'.repeat(300))).toContain(`q=${'x'.repeat(100)}&`);
  });

  it('the token goes only to apiBase, as a header, with no cookie', async () => {
    const { calls, source } = setup();
    await source.lookup(lookup.id, 'acm', signal());
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url.startsWith(`${BASE}/`)).toBe(true);
      expect(c.init.credentials).toBe('omit');
      expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toContain(TOKEN);
    }
  });

  it('projects like the bridge path: no secret, hidden or masked value in any cell', async () => {
    const { source } = setup();
    const out = await source.lookup(lookup.id, 'acm', signal());
    const text = JSON.stringify(out);
    expect(text).not.toContain('do not share');
    expect(text).not.toContain('•');
  });

  it('the source master is read once per page view', async () => {
    const { calls, source } = setup();
    await source.lookup(lookup.id, 'a', signal());
    await source.lookup(lookup.id, 'ac', signal());
    expect(calls.filter((c) => c.url.includes('/dms/masters/'))).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('/master/form/'))).toBe(false);
  });

  it('B\'s flags come from GET masters/{id}: a hidden column never fills, even for a revealer (review should-fix)', async () => {
    const NOTE = fx.sourceMasterElements[4]!.id;
    const hiddenFill: PublicLookup = { ...lookup, mappings: [{ key: NOTE, fieldId: fp.fill[0]!.to as never }] };
    // A revealer: master-records returns the hidden column in clear (no __masked sibling).
    const records = { data: { records: [{ id: 'r1', json_data: { 'Vendor Name': 'Acme Traders', 'Internal Note': 'do not share' } }] } };
    const { calls, source } = setup({ records, lookups: [hiddenFill] });
    const out = await source.lookup(hiddenFill.id, 'acme', signal());
    expect(calls.some((c) => c.url === `${BASE}/dms/masters/${fp.master_id}`)).toBe(true);
    expect(out.rows.map((r) => r.label)).toEqual(['Acme Traders']);
    expect(JSON.stringify(out)).not.toContain('do not share');
  });

  it('fails closed when the master route returns fields without the flags', async () => {
    const { source } = setup({ elements: fx.sourceMasterElements.map(({ is_secret: _s, is_hidden: _h, ...e }) => e) });
    expect(await source.lookup(lookup.id, 'acm', signal())).toEqual({ rows: [], truncated: false });
  });

  it('an undeclared id, or an http lookup, makes no call', async () => {
    const calls: string[] = [];
    const client = { request: vi.fn(async (_m: string, p: string) => (calls.push(p), {})) } as never;
    const source = dmsDirectRemoteSource(client, [lookup, { ...lookup, id: 'h', source: 'http' }]);
    expect((await source.lookup('nope', 'a', signal())).rows).toEqual([]);
    expect((await source.lookup('h', 'a', signal())).rows).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('a failed master read is not cached: the next search tries again', async () => {
    let n = 0;
    const client = {
      request: vi.fn(async (_m: string, p: string) => {
        if (p.includes('/dms/masters/')) {
          n += 1;
          if (n === 1) throw new Error('down');
          return { data: { form_builders: flagged } };
        }
        return fx.masterRecordsResponse;
      }),
    } as never;
    const source = dmsDirectRemoteSource(client, [lookup]);
    await expect(source.lookup(lookup.id, 'a', signal())).rejects.toThrow();
    expect((await source.lookup(lookup.id, 'a', signal())).rows).toHaveLength(2);
  });
});
