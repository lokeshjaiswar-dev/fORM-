import { describe, expect, it } from 'vitest';
import { mappingOf, previewOf, rowsOf } from '@/components/settings/webhookBody';

const fields = [{ key: 'name', label: 'Name' }];

describe('webhook body preview', () => {
  it('round-trips rows and mapping, dropping unfinished rows', () => {
    const rows = [
      { path: 'a.b', kind: 'answer' as const, ref: 'name' },
      { path: '', kind: 'answer' as const, ref: 'name' },
      { path: 'id', kind: 'meta' as const, ref: 'submissionId' },
      { path: 'x', kind: 'answer' as const, ref: '' },
    ];
    const mapping = mappingOf(rows, ' order ');
    expect(mapping).toEqual({ root: 'order', entries: [{ path: 'a.b', source: { kind: 'answer', key: 'name' } }, { path: 'id', source: { kind: 'meta', name: 'submissionId' } }] });
    expect(rowsOf(mapping)).toEqual([rows[0], rows[2]]);
  });

  it('previews JSON and XML from samples, spreading over []', () => {
    const m = mappingOf([{ path: 'p[].n', kind: 'answer', ref: 'name' }], '');
    expect(JSON.parse(previewOf('json', m, fields).text)).toEqual({ p: [{ n: 'Name (sample) 1' }, { n: 'Name (sample) 2' }] });
    expect(previewOf('xml', m, fields).text).toContain('<submission>');
  });

  it('reports issues instead of a preview', () => {
    const p = previewOf('json', mappingOf([{ path: '1x', kind: 'answer', ref: 'name' }], ''), fields);
    expect(p.text).toBe('');
    expect(p.issues).toHaveLength(1);
  });
});
