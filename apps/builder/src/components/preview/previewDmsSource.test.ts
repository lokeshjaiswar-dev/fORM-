import { describe, expect, it, vi } from 'vitest';
import type { PublicLookup } from '@form/schema';
import { fixtures } from '@/embed/bridge/fixtures';
import { previewDmsSource } from '@/components/preview/previewDmsSource';
import { previewRemoteSource } from '@/components/preview/previewRemoteSource';
import { formWith, block } from '@/test/fixtures';

const fx = fixtures.lookup;
const fp = fx.pickerElement.fp_lookup;
const dmsLookup: PublicLookup = {
  id: fp.id,
  source: 'dms_master',
  masterId: fp.master_id,
  pickerFieldId: fx.pickerElement.id as never,
  pickerKey: fp.label_field_id,
  mappings: fp.fill.map((f) => ({ key: f.from, fieldId: f.to as never })),
  minChars: 2,
  maxRows: 20,
};
const flagged = fx.sourceMasterElements.map((e) => ({ ...e, is_hidden: Boolean(e.is_hidden), is_secret: Boolean(e.is_secret) }));
const signal = () => new AbortController().signal;

describe('the builder preview runs Fill from master lookups through DMS (review nit)', () => {
  it('previewDmsSource answers a dms_master lookup with the direct DMS source, as the user', async () => {
    const request = vi.fn(async (_m: string, path: string) => (path.startsWith('/dms/masters/') ? { data: { form_builders: flagged } } : fx.masterRecordsResponse));
    const source = previewDmsSource([dmsLookup], { request: request as never });
    expect(source).not.toBeNull();
    const out = await source!.lookup(dmsLookup.id, 'acm', signal());
    expect(out.rows.map((r) => r.label)).toEqual(['Acme Traders', 'Acme Foods']);
    expect(request).toHaveBeenCalledWith('GET', expect.stringMatching(/^\/dms\/master-records\?id=m-vendors&q=acm/));
  });

  it('is null without a dms_master lookup, or without a DMS launch (the page then says so)', () => {
    expect(previewDmsSource([], { request: vi.fn() as never })).toBeNull();
    expect(previewDmsSource(undefined)).toBeNull();
    expect(previewDmsSource([dmsLookup])).toBeNull();
  });

  it('previewRemoteSource hands a dms_master lookup to the DMS source, and keeps it empty without one', async () => {
    const def = {
      ...formWith([block('short_text', 'emp', { key: 'emp' })]),
      formId: 'f1' as never,
      lookups: [{ ...dmsLookup, enabled: true }],
    } as never;
    const dms = { lookup: vi.fn(async () => ({ rows: [{ label: 'Acme', cells: {} }], truncated: false })) };
    expect((await previewRemoteSource('o1', def, dms).lookup(dmsLookup.id, 'ac', signal())).rows).toEqual([{ label: 'Acme', cells: {} }]);
    expect(dms.lookup).toHaveBeenCalledWith(dmsLookup.id, 'ac', expect.any(AbortSignal));
    expect((await previewRemoteSource('o1', def).lookup(dmsLookup.id, 'ac', signal())).rows).toEqual([]);
  });
});
