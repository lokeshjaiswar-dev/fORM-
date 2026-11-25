import { describe, expect, it } from 'vitest';
import { lookupAnswer, lookupRows } from '../src/controls/apiLookup.ts';

const data = {
  data: {
    employees: [
      { empId: 'E1', name: 'Lokesh', designation: 'Engineer' },
      { empId: 'E2', name: 'Jayesh', designation: 'Manager' },
    ],
  },
};

describe('lookupRows', () => {
  it('reads the named list and the mapped keys', () => {
    expect(lookupRows(data, { itemsPath: 'data.employees', pickerKey: 'name', mappings: [{ key: 'designation', fieldId: 'f1' as never }] })).toEqual([
      { index: 0, label: 'Lokesh', cells: { name: 'Lokesh', designation: 'Engineer' } },
      { index: 1, label: 'Jayesh', cells: { name: 'Jayesh', designation: 'Manager' } },
    ]);
  });

  it('copies a value that sits outside the list onto every row', () => {
    const payload = { company: { name: 'dMACQ', code: 'DMQ' }, ...data };
    const rows = lookupRows(payload, { itemsPath: 'data.employees', pickerKey: 'name', mappings: [{ key: 'company.name' }, { key: 'company.code' }] });
    expect(rows[0]?.cells['company.name']).toBe('dMACQ');
    expect(rows[1]?.cells['company.code']).toBe('DMQ');
  });

  it('turns a number field into a number answer', () => {
    expect(lookupAnswer('number', '12')).toEqual({ type: 'number', value: '12' });
    expect(lookupAnswer('short_text', 'Lokesh')).toEqual({ type: 'short_text', value: 'Lokesh' });
  });
});
