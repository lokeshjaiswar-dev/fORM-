import { describe, expect, it } from 'vitest';
import type { DmsElement } from '@form/registry/profiles/dms-v1';
import fixtures from './__fixtures__/dms-record.fixtures.json' with { type: 'json' };
import { diffRecordValues, parseRecordJson, recordReturnTarget, type LoadedDmsRecord } from './contract';

const elements = fixtures.loadMaster.response.body.data.form_builder_fields as DmsElement[];
const stored = fixtures.loadRecord.response.body.data.json_data;

const loaded = (over: Partial<LoadedDmsRecord> = {}): LoadedDmsRecord => ({
  masterId: fixtures.descriptor.edit.masterId,
  masterName: 'Vendor',
  source: 'formplus',
  elements,
  recordId: fixtures.descriptor.edit.recordId,
  values: parseRecordJson(stored),
  ...over,
});

describe('parseRecordJson', () => {
  it('reads a JSON string and an object alike, keyed by field name', () => {
    const fromString = parseRecordJson(stored);
    expect(fromString['Vendor Name']).toBe('Acme');
    expect(parseRecordJson(JSON.parse(stored))).toEqual(fromString);
  });
  it('turns null and numbers into strings, and empty input into no values', () => {
    expect(parseRecordJson({ A: null, B: 5, C: true })).toEqual({ A: '', B: '5', C: 'true' });
    expect(parseRecordJson('')).toEqual({});
    expect(parseRecordJson(null)).toEqual({});
    expect(parseRecordJson('[]')).toEqual({});
  });
  it('refuses text that is not a JSON object', () => {
    expect(() => parseRecordJson('{nope')).toThrow(/cannot read/);
    expect(() => parseRecordJson('"x"')).toThrow(/cannot read/);
  });
});

describe('diffRecordValues', () => {
  it('is null when nothing changed', () => {
    expect(diffRecordValues(loaded(), { ...loaded().values })).toBeNull();
  });
  it('carries only the changed field (the fixture update body)', () => {
    expect(diffRecordValues(loaded(), { ...loaded().values, Tier: 'Silver' })).toEqual(fixtures.update.request.body.json_data);
  });
  it('never carries a legacy field, even if its value differs', () => {
    expect(diffRecordValues(loaded(), { ...loaded().values, Docs: 'other' })).toBeNull();
  });
  it('treats a date as unchanged across DD-MM-YYYY and YYYY-MM-DD', () => {
    expect(diffRecordValues(loaded(), { ...loaded().values, Joined: '01-11-2026' })).toBeNull();
    expect(diffRecordValues(loaded(), { ...loaded().values, Joined: '02-11-2026' })).toEqual({ Joined: '02-11-2026' });
  });
  it('a cleared field is sent as an empty string, a missing key counts as empty', () => {
    expect(diffRecordValues(loaded(), { ...loaded().values, Phone: '' })).toEqual({ Phone: '' });
    expect(diffRecordValues(loaded({ values: {} }), {})).toBeNull();
  });
  it('never carries an auto-increment field', () => {
    const inc = [{ id: 'x', type: 'textinput', name: 'No', value: 'No', increment: true } as DmsElement];
    expect(diffRecordValues(loaded({ elements: inc, values: { No: 'A1' } }), { No: 'A2' })).toBeNull();
  });
});

describe('recordReturnTarget', () => {
  const back = fixtures.descriptor.edit.returnUrl;
  it('matches the fixture return strings', () => {
    expect(recordReturnTarget(back, 'saved', fixtures.descriptor.edit.masterId, fixtures.descriptor.edit.recordId)).toBe(`${back}?${fixtures.return.saved}`);
    expect(recordReturnTarget(back, 'cancelled', fixtures.descriptor.edit.masterId)).toBe(`${back}?${fixtures.return.cancelled}`);
  });
  it('appends with & when the return URL has a query', () => {
    expect(recordReturnTarget(`${back}?tab=2`, 'cancelled', 'm')).toBe(`${back}?tab=2&fp_status=cancelled&fp_master_id=m`);
  });
});
