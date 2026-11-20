import { describe, expect, it } from 'vitest';
import { payloadPreview } from '@/lib/payloadBody';

describe('payloadPreview', () => {
  it('nests dotted paths into json and xml', () => {
    const keys = [
      { path: 'customer.name', sample: 'Lokesh' },
      { path: 'items.0.sku', sample: 'A1' },
    ];
    expect(JSON.parse(payloadPreview('json', keys).text)).toEqual({
      customer: { name: 'Lokesh' },
      items: [{ sku: 'A1' }],
    });
    const xml = payloadPreview('xml', keys).text;
    expect(xml).toContain('<customer>');
    expect(xml).toContain('<name>Lokesh</name>');
    expect(xml).toContain('<sku>A1</sku>');
  });

  it('reports a path that cannot be an element or a key', () => {
    const preview = payloadPreview('json', [{ path: 'full name', sample: 'x' }]);
    expect(preview.invalid).toEqual(['full name']);
    expect(preview.text).toBe('{}');
  });

  it('spreads a column across one object per row', () => {
    const preview = payloadPreview('json', [
      { path: 'order.lines[].item', sample: ['Pen', 'Book'] },
      { path: 'order.lines[].amount', sample: ['10', '20'] },
      { path: 'order.total', sample: 30 },
    ]);
    expect(JSON.parse(preview.text)).toEqual({
      order: { lines: [{ item: 'Pen', amount: '10' }, { item: 'Book', amount: '20' }], total: 30 },
    });
  });
});
