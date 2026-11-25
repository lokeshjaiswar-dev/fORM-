import { describe, expect, it } from 'vitest';
import { fixtures } from '../bridge/fixtures.ts';
import { DMS_FETCH_ROWS, SECRET_MASK, projectMasterRecords, sourceElementsOf, sourceFieldsOf, sourceMasterPath } from './dmsRows.ts';

const fx = fixtures.lookup;
const [, ...fillOnly] = fx.pickerElement.fp_lookup.fill;
void fillOnly;
const lookup = { pickerKey: fx.pickerElement.fp_lookup.label_field_id, mappings: fx.pickerElement.fp_lookup.fill.map((f) => ({ key: f.from })) };
/** B's elements as GET masters/{id} returns them: both flags on every field (from master_fields.properties). */
const flagged = fx.sourceMasterElements.map((e) => ({ ...e, is_hidden: Boolean(e.is_hidden), is_secret: Boolean(e.is_secret) }));
const fields = sourceFieldsOf(flagged);
const ID = (n: number) => `b2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NAME = ID(1), CITY = ID(2), PHONE = ID(3), TAX = ID(4), NOTE = ID(5);

describe('projectMasterRecords against the contract fixture (T-BR-L8)', () => {
  const out = projectMasterRecords(fx.masterRecordsResponse, lookup, fields);

  it('keeps the usable rows: the string json_data and the object one; the row with no label is dropped', () => {
    expect(out.rows.map((r) => r.label)).toEqual(['Acme Traders', 'Acme Foods']);
  });

  it('a secret field is never a cell: not by its flag, not by the mask, not by a __masked sibling', () => {
    for (const row of out.rows) expect(Object.keys(row.cells)).not.toContain(TAX);
    expect(JSON.stringify(out)).not.toContain(SECRET_MASK);
    expect(JSON.stringify(out)).not.toContain('\\u2022');
  });

  it('a hidden field is never a cell, and a masked phone (value is the mask) is dropped from that row only', () => {
    expect(JSON.stringify(out)).not.toContain('do not share');
    for (const row of out.rows) expect(Object.keys(row.cells)).not.toContain(NOTE);
    expect(out.rows[0]!.cells).toEqual({ [NAME]: 'Acme Traders', [CITY]: 'Pune', [PHONE]: '9800000001' });
    expect(out.rows[1]!.cells).toEqual({ [NAME]: 'Acme Foods', [CITY]: 'Delhi' });
  });

  it('only the label column and the declared fill columns can be cells', () => {
    const wide = { ...lookup, mappings: [{ key: CITY }] };
    const rows = projectMasterRecords(fx.masterRecordsResponse, wide, fields).rows;
    expect(Object.keys(rows[0]!.cells).sort()).toEqual([NAME, CITY].sort());
  });

  it('with no flags and no mask a value still has to be declared; the mask text itself and a __masked key drop it even for an unflagged field', () => {
    const plain = sourceFieldsOf(fx.sourceMasterElements.map(({ is_secret: _s, is_hidden: _h, ...rest }) => rest), { requireFlags: false });
    const rows = projectMasterRecords(fx.masterRecordsResponse, lookup, plain).rows;
    expect(JSON.stringify(rows)).not.toContain(SECRET_MASK);
    for (const row of rows) expect(Object.keys(row.cells)).not.toContain(TAX);
  });

  it('a secret or hidden label column gives no rows at all', () => {
    expect(projectMasterRecords(fx.masterRecordsResponse, { ...lookup, pickerKey: TAX }, fields)).toEqual({ rows: [], truncated: false });
    expect(projectMasterRecords(fx.masterRecordsResponse, { ...lookup, pickerKey: NOTE }, fields)).toEqual({ rows: [], truncated: false });
    expect(projectMasterRecords(fx.masterRecordsResponse, { ...lookup, pickerKey: ID(99) }, fields).rows).toEqual([]);
  });
});

describe('B\'s flags fail closed (review: json_data may lack is_hidden/is_secret)', () => {
  it('a field without both flags is hidden: never a cell, and as the label column it gives no rows', () => {
    // json_data saved without flags; a revealer gets the hidden column in clear from master-records.
    const unflagged = sourceFieldsOf(fx.sourceMasterElements.map(({ is_secret: _s, is_hidden: _h, ...rest }) => rest));
    const fillNote = { pickerKey: NAME, mappings: [{ key: NOTE }] };
    const records = { data: { records: [{ id: 'r1', json_data: { 'Vendor Name': 'Acme Traders', 'Internal Note': 'do not share' } }] } };
    expect(projectMasterRecords(records, fillNote, unflagged)).toEqual({ rows: [], truncated: false });
    const half = sourceFieldsOf([{ ...flagged[0] }, { id: NOTE, value: 'Internal Note', is_secret: false }]);
    const out = projectMasterRecords(records, fillNote, half);
    expect(out.rows.map((r) => r.label)).toEqual(['Acme Traders']);
    expect(JSON.stringify(out)).not.toContain('do not share');
  });

  it('the flags come from GET masters/{id} form_builders (array or JSON string)', () => {
    expect(sourceMasterPath('m/1')).toBe('/dms/masters/m%2F1');
    expect(sourceElementsOf({ data: { form_builders: flagged } })).toEqual(flagged);
    expect(sourceElementsOf({ data: { form_builders: JSON.stringify(flagged) } })).toEqual(flagged);
    expect(sourceElementsOf({ data: { form_builder_fields: flagged } })).toBeUndefined();
  });
});

describe('projectMasterRecords: caps and truncation', () => {
  const records = (n: number) => ({ data: { records: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, json_data: { 'Vendor Name': `V${i}`, City: 'x'.repeat(2000) } })), total_items: n + 10 } });

  it('at most 20 rows, truncated when more matched; label and cell text are cut', () => {
    const out = projectMasterRecords(records(DMS_FETCH_ROWS), lookup, fields);
    expect(out.rows).toHaveLength(20);
    expect(out.truncated).toBe(true);
    expect(out.rows[0]!.cells[CITY]).toHaveLength(1000);
  });

  it('a response total larger than the list says truncated (ES total_items), else not', () => {
    expect(projectMasterRecords(records(3), lookup, fields).truncated).toBe(true);
    expect(projectMasterRecords({ data: { records: records(3).data.records, total: 3 } }, lookup, fields).truncated).toBe(false);
  });

  it('a row cap below 20 is honoured, and nothing above 20 is', () => {
    expect(projectMasterRecords(records(15), lookup, fields, 5).rows).toHaveLength(5);
    expect(projectMasterRecords(records(30), lookup, fields, 99).rows).toHaveLength(20);
  });

  it('garbage is no rows, not an exception', () => {
    for (const bad of [null, undefined, 'x', 3, {}, { data: { records: 'x' } }, { data: { records: [null, 3, { json_data: '{' }, { json_data: [] }] } }]) {
      expect(projectMasterRecords(bad, lookup, fields).rows).toEqual([]);
    }
  });
});
