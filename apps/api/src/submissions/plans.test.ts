import { describe, expect, it } from 'vitest';
import { cellsOf, detailFieldsOf, gridColumns, maskedAnswersOf, MASK, planOf } from './plans.ts';
import { answers, definitionOf, fieldBlock, group, labelled, sensitive } from './test-fixtures.ts';

const plan = (id: string, number: number, definition: ReturnType<typeof definitionOf>, taint: unknown = null) => planOf({ id, number, definition, taint });

describe('gridColumns', () => {
  const v1 = plan('v1', 1, definitionOf([labelled(fieldBlock('name', 'short_text'), 'Name'), fieldBlock('fax', 'short_text')]));
  const v2 = plan('v2', 2, definitionOf([labelled(fieldBlock('name', 'short_text'), 'Full name'), fieldBlock('mail', 'email')]));

  it('is the union of every version’s fields, one column per block id, labelled by the newest version', () => {
    expect(gridColumns([v2, v1])).toEqual([
      { id: 'name', key: 'name', label: 'Full name', type: 'short_text' },
      { id: 'mail', key: 'mail', label: 'mail', type: 'email' },
      // Only version 1 had it: its answers stay readable, after the fields the form asks now.
      { id: 'fax', key: 'fax', label: 'fax', type: 'short_text' },
    ]);
  });

  it('is empty for a form with no versions or for the stand-in version of a never-published form', () => {
    expect(gridColumns([])).toEqual([]);
    expect(gridColumns([plan('legacy', 0, definitionOf([]))])).toEqual([]);
  });

  it('heads a field that exports several columns by the field’s own label, not by a part', () => {
    const name = { ...labelled(fieldBlock('who', 'short_text'), 'Applicant'), type: 'full_name', config: { parts: ['first', 'last'], requiredParts: ['first'] } };
    expect(gridColumns([plan('v', 1, definitionOf([name as never]))])).toEqual([{ id: 'who', key: 'who', label: 'Applicant', type: 'full_name' }]);
  });
});

describe('cellsOf', () => {
  const p = plan('v1', 1, definitionOf([fieldBlock('name', 'short_text'), sensitive(fieldBlock('pan', 'short_text')), fieldBlock('mail', 'email'), fieldBlock('city', 'short_text')]));

  it('builds the text of each answered field with the field type’s export, and a mask for a protected one', () => {
    expect(cellsOf(p, answers({ name: ['short_text', 'Asha'], pan: ['short_text', 'ABCDE1234F'], mail: ['email', { address: 'a@b.test' }] }))).toEqual({
      cells: { name: 'Asha', pan: MASK, mail: 'a@b.test' },
      masked: ['pan'],
    });
  });

  it('says nothing of a field that was not answered, was blank, or is not in the response’s version', () => {
    const { cells } = cellsOf(p, answers({ name: ['short_text', '  '], stray: ['short_text', 'from another version'] }));
    expect(cells).toEqual({});
    expect(cellsOf(undefined, answers({ name: ['short_text', 'x'] }))).toEqual({ cells: {}, masked: [] });
  });

  it('bounds a long answer and makes control characters storable', () => {
    const { cells } = cellsOf(p, answers({ name: ['short_text', `${'x'.repeat(2000)}\u0000`] }));
    expect(cells.name).toHaveLength(500);
    expect(cells.name!.endsWith('…')).toBe(true);
    expect(cellsOf(p, answers({ name: ['short_text', 'a\u0007b'] })).cells.name).toBe('a b');
  });

  it('masks a group with a protected child, and a value derived from a sensitive one', () => {
    const grouped = plan(
      'v',
      1,
      definitionOf([group('people', ['who', 'pan']), fieldBlock('score', 'short_text')], [fieldBlock('who', 'short_text'), sensitive(fieldBlock('pan', 'short_text'))]),
      { 'value:score': { classification: 'sensitive', purposeIds: ['pur_1'] } },
    );
    const rows = { rows: [{ rowId: 'r1', values: { who: { type: 'short_text', value: 'Ravi' }, pan: { type: 'short_text', value: 'ABCDE1234F' } } }] };
    const { cells, masked } = cellsOf(grouped, answers({ people: ['repeating_group', rows], score: ['short_text', 'derived'] }));
    expect(cells).toEqual({ people: MASK, score: MASK });
    expect(masked).toEqual(['people', 'score']);
  });
});

describe('detailFieldsOf and maskedAnswersOf', () => {
  const p = plan('v1', 1, definitionOf([labelled(fieldBlock('name', 'short_text'), 'Name'), labelled(sensitive(fieldBlock('pan', 'short_text')), 'PAN')]));
  const stored = { name: { type: 'short_text', value: 'Asha' }, pan: { type: 'short_text', value: 'ABCDE1234F' }, stray: { type: 'short_text', value: 'not in this version' } };

  it('lists the answered fields with their labels, and masks the protected value', () => {
    expect(detailFieldsOf(p, stored)).toEqual([
      { id: 'name', key: 'name', label: 'Name', type: 'short_text', value: 'Asha', masked: false },
      { id: 'pan', key: 'pan', label: 'PAN', type: 'short_text', value: MASK, masked: true },
    ]);
    expect(detailFieldsOf(undefined, stored)).toEqual([]);
  });

  it('keeps the plain answers as stored and replaces a protected one, and one the version does not know, with a marker', () => {
    expect(maskedAnswersOf(p, stored)).toEqual({
      name: { type: 'short_text', value: 'Asha' },
      pan: { type: 'short_text', masked: true },
      stray: { type: 'short_text', masked: true },
    });
    // With no plan at all nothing can be vouched for.
    expect(maskedAnswersOf(undefined, stored)).toEqual({
      name: { type: 'short_text', masked: true },
      pan: { type: 'short_text', masked: true },
      stray: { type: 'short_text', masked: true },
    });
    expect(JSON.stringify(maskedAnswersOf(p, stored))).not.toContain('ABCDE1234F');
  });
});
