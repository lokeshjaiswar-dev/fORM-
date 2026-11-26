import { describe, expect, it } from 'vitest';
import type { DmsElement } from '@form/registry/profiles/dms-v1';
import fixtures from './__fixtures__/dms-record.fixtures.json' with { type: 'json' };
import {
  createRecordValues, diffRecordValues, isHiddenElement, isSecretElement, parseRecordCells, parseRecordJson, recordReturnTarget, secretNames, secretToWrite, SECRET_MASK, withoutMasked,
  type LoadedDmsRecord,
} from './contract';

const elements = fixtures.loadMaster.response.body.data.form_builder_fields as DmsElement[];
const stored = fixtures.loadRecord.response.body.data.json_data;

const loaded = (over: Partial<LoadedDmsRecord> = {}): LoadedDmsRecord => ({
  masterId: fixtures.descriptor.edit.masterId,
  masterName: 'Vendor',
  source: 'formplus',
  elements,
  recordId: fixtures.descriptor.edit.recordId,
  values: parseRecordJson(stored),
  masked: [],
  canReveal: null,
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

describe('secrets in a record (SEC-DESIGN 5.3)', () => {
  const secret = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, type: 'textinput', name, value: name, label: name, required: false, placeholder: '', ...extra }) as DmsElement;
  const withSecret = [secret('s1', 'Name'), secret('s2', 'Tax Id', { is_secret: true }), secret('s3', 'Note', { is_hidden: true })];

  it('the mask and its __masked sibling read as a stored secret: value empty, name listed, no __masked key left', () => {
    expect(parseRecordCells({ Name: 'Acme', 'Tax Id': SECRET_MASK, 'Tax Id__masked': true })).toEqual({ values: { Name: 'Acme', 'Tax Id': '' }, masked: ['Tax Id'] });
    expect(parseRecordJson(JSON.stringify({ 'Tax Id': SECRET_MASK, 'Tax Id__masked': true }))).toEqual({ 'Tax Id': '' });
    expect(SECRET_MASK).toBe('\u2022\u2022\u2022\u2022\u2022\u2022');
  });

  it('flags: secret and hidden come from the element, as booleans', () => {
    expect(withSecret.map((e) => [isSecretElement(e), isHiddenElement(e)])).toEqual([[false, false], [true, false], [false, true]]);
    expect(isSecretElement({ ...withSecret[0]!, is_secret: 1 } as unknown as DmsElement)).toBe(true);
  });

  it('secretNames is the flagged secrets plus the cells that came back masked', () => {
    expect([...secretNames({ elements: withSecret, masked: ['Name'] })].sort()).toEqual(['Name', 'Tax Id']);
  });

  it('an edit sends a secret only when a new value was typed; blank and the mask stay out', () => {
    const l = loaded({ elements: withSecret, values: { Name: 'Acme', 'Tax Id': '', Note: '' }, masked: ['Tax Id'] });
    expect(diffRecordValues(l, { Name: 'Acme', 'Tax Id': '' })).toBeNull();
    expect(diffRecordValues(l, { Name: 'Acme', 'Tax Id': SECRET_MASK })).toBeNull();
    expect(diffRecordValues(l, { Name: 'Acme', 'Tax Id': 'new-value' })).toEqual({ 'Tax Id': 'new-value' });
    expect(diffRecordValues(l, { Name: 'Beta', 'Tax Id': SECRET_MASK })).toEqual({ Name: 'Beta' });
  });

  it('a secret with no stored value behaves as a secret too: typed is sent, blank is not', () => {
    const l = loaded({ elements: withSecret, values: { Name: 'Acme', 'Tax Id': '', Note: '' }, masked: [] });
    expect(diffRecordValues(l, { Name: 'Acme', 'Tax Id': 'typed' })).toEqual({ 'Tax Id': 'typed' });
    expect(diffRecordValues(l, { Name: 'Acme', 'Tax Id': '' })).toBeNull();
  });

  it('a create sends every writable field, but a secret only as typed (blank or mask: an empty string)', () => {
    const l = loaded({ elements: withSecret, recordId: null, values: {}, masked: [] });
    expect(createRecordValues(l, { Name: 'Acme', 'Tax Id': SECRET_MASK, Note: 'n' })).toEqual({ Name: 'Acme', 'Tax Id': '', Note: 'n' });
    expect(createRecordValues(l, { Name: 'Acme', 'Tax Id': 'real' })).toEqual({ Name: 'Acme', 'Tax Id': 'real', Note: '' });
    expect(secretToWrite(undefined)).toBeUndefined();
    expect(secretToWrite('x')).toBe('x');
  });

  it('withoutMasked drops __masked keys and a secret holding the mask, and nothing else', () => {
    expect(withoutMasked({ A: '1', 'A__masked': 'true', S: SECRET_MASK, T: 'x', P: SECRET_MASK }, new Set(['S', 'T']))).toEqual({ A: '1', T: 'x', P: SECRET_MASK });
  });
});

describe('recordReturnTarget: the error variant (DESIGN 3.5)', () => {
  const back = fixtures.descriptor.edit.returnUrl;
  it('error carries the code and the master id, never a record id; a malformed code is left out', () => {
    expect(recordReturnTarget(back, 'error', 'm1', 'r1', 'NOT_FOUND')).toBe(`${back}?fp_status=error&fp_master_id=m1&fp_code=NOT_FOUND`);
    expect(recordReturnTarget(back, 'error', 'm1', undefined, 'not a code')).toBe(`${back}?fp_status=error&fp_master_id=m1`);
    expect(recordReturnTarget(back, 'saved', 'm1', 'r1', 'NOT_FOUND')).toBe(`${back}?fp_status=saved&fp_master_id=m1&fp_record_id=r1`);
  });
});
