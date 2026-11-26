import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@/embed/contract';
import errors from '@/embed/contract/__fixtures__/fp-errors.fixtures.json' with { type: 'json' };
import { DmsApiError } from '@/embed/dmsClient';
import { describeRecordError } from '@/embed/record/describeRecordError';
import {
  describeDmsError, errorCodeOf, FP_ERROR_MESSAGES, GENERIC_ERROR_MESSAGE, referenceLine, referenceOf, removalCountChangedOf, schemaSyncOf, terminalLoadCodeOf, TERMINAL_LOAD_CODES,
} from './describeDmsError';
import { returnTarget } from '@/embed/launch';

/*
 * DT-10 (DESIGN 3.4, 3.5): describeDmsError and describeRecordError know every code of the error table, with the contract's English message,
 * show the reference, and the codes after which the page cannot continue return to DMS with fp_status=error&fp_code=<code>.
 */

const MASTER = 'b9000000-0000-4000-8000-000000000001';
const RID = '7e000000-0000-4000-8000-0000000000cc';
const envelope = (code: string, over: Record<string, unknown> = {}) => ({ success: false, code, message: 'the server\'s own wording', request_id: RID, ...over });
const fail = (status: number, code: string | number | null, body: unknown = envelope(String(code))) => new DmsApiError(status, 'the server\'s own wording', code, body, RID);

describe('every code of the error table (fp-errors fixture)', () => {
  const rows = errors.codes as Array<{ code: (typeof ERROR_CODES)[number]; status: number; message: string }>;

  it('the table has a row for each contract code and nothing else', () => {
    expect(rows.map((r) => r.code).sort()).toEqual([...ERROR_CODES].sort());
    expect(Object.keys(FP_ERROR_MESSAGES).sort()).toEqual([...ERROR_CODES].sort());
  });

  it.each(rows.map((r) => [r.code, r] as const))('%s: the message is the contract message, whatever wording the server used', (code, row) => {
    expect(FP_ERROR_MESSAGES[code]).toBe(row.message);
    expect(describeDmsError(fail(row.status, code))).toBe(row.message);
    expect(describeRecordError(fail(row.status, code))).toEqual([row.message]);
  });

  it.each(rows.map((r) => [r.code, r] as const))('%s: the reference is the request id of the answer', (code, row) => {
    const e = fail(row.status, code);
    expect(referenceOf(e)).toBe(RID);
    expect(referenceLine(e)).toBe(`Reference: ${RID}`);
    expect(errorCodeOf(e)).toBe(code);
  });

  it('a code that is a number, a made-up code or no code is not one of the table', () => {
    expect(errorCodeOf(fail(409, 2051))).toBeNull();
    expect(errorCodeOf(fail(409, 'SOMETHING_NEW'))).toBeNull();
    expect(errorCodeOf(fail(500, null))).toBeNull();
    expect(errorCodeOf(new Error('x'))).toBeNull();
  });
});

describe('unknown and legacy answers', () => {
  it('a well-formed code from a newer server, in the new envelope, reads as the generic text (never the raw code or the server wording)', () => {
    const e = fail(422, 'SOMETHING_NEW');
    expect(describeDmsError(e)).toBe(GENERIC_ERROR_MESSAGE);
    expect(describeDmsError(e)).toBe(errors.genericMessage);
    expect(describeRecordError(e)).toEqual([GENERIC_ERROR_MESSAGE]);
    expect(referenceLine(e)).toBe(`Reference: ${RID}`);
  });

  it('the shapes DMS answered before this run are described as they were (DESIGN 3.4: existing behaviours are not re-coded)', () => {
    const legacy = (status: number, message: string, code: string | number | null) => new DmsApiError(status, message, code, { message });
    expect(describeDmsError(legacy(409, 'Used by workflow W.', 2051))).toMatch(/running workflow uses this master/);
    expect(describeDmsError(legacy(404, 'x', 'ALREADY_EXISTS'))).toMatch(/already exists/);
    expect(describeDmsError(legacy(503, 'x', 5031))).toMatch(/Workflows are not available/);
    expect(describeDmsError(legacy(403, 'x', null))).toMatch(/permission/);
    expect(describeDmsError(legacy(422, 'Bad.', 'DUPLICATE_FIELD_NAME'))).toBe('Bad. (DUPLICATE_FIELD_NAME)');
    expect(describeDmsError(legacy(500, 'Boom.', null))).toBe('Boom.');
  });

  it('SCHEMA_SYNC_FAILED keeps its two messages and its data (saved true: the new token and master id are adopted)', () => {
    const sync = (saved: boolean) => new DmsApiError(500, 'x', 'SCHEMA_SYNC_FAILED', { data: { master_id: MASTER, saved, updated_at: 'T' } });
    expect(describeDmsError(sync(true))).toMatch(/changes were saved, but/);
    expect(describeDmsError(sync(false))).toMatch(/nothing was saved/);
    expect(schemaSyncOf(sync(true))).toEqual({ saved: true, masterId: MASTER, updatedAt: 'T' });
    expect(schemaSyncOf(fail(409, 'MASTER_CHANGED'))).toBeNull();
  });

  it('a plain Error shows its own text, and anything else the generic save failure', () => {
    expect(describeDmsError(new Error('offline'))).toBe('offline');
    expect(describeDmsError('x')).toBe('The master could not be saved.');
    expect(describeRecordError('x')).toEqual(['The record could not be saved.']);
    expect(referenceLine(new Error('offline'))).toBeNull();
  });

  it('a record validation answer (errors.json_data) keeps its lines, and 403 with no code is a permission message', () => {
    const lines = new DmsApiError(422, 'x', null, { errors: { json_data: ['Tier is not one of the options.', 'Phone is not valid.'] } });
    expect(describeRecordError(lines)).toEqual(['Tier is not one of the options.', 'Phone is not valid.']);
    expect(describeRecordError(new DmsApiError(403, 'x', null, {}))).toEqual(['You do not have permission to save this record.']);
    expect(describeRecordError(new DmsApiError(500, 'Boom.', null, null))).toEqual(['Boom.']);
  });
});

describe('terminal load errors and the return URL (DESIGN 3.5)', () => {
  const back = 'https://dms.example.test/dms/t/documents/master';

  it('exactly NOT_FOUND, FORBIDDEN_RIGHT, FP_SCOPE_DENIED and MASTER_NOT_CONVERTED end the page', () => {
    expect([...TERMINAL_LOAD_CODES].sort()).toEqual(['FORBIDDEN_RIGHT', 'FP_SCOPE_DENIED', 'MASTER_NOT_CONVERTED', 'NOT_FOUND']);
    for (const code of ERROR_CODES) {
      expect(terminalLoadCodeOf(fail(400, code)) !== null, code).toBe((TERMINAL_LOAD_CODES as readonly string[]).includes(code));
    }
  });

  it.each(TERMINAL_LOAD_CODES)('%s: the return URL carries fp_status=error, the master id and fp_code (and passes the contract parser)', async (code) => {
    const href = returnTarget(back, 'error', MASTER, terminalLoadCodeOf(fail(403, code))!);
    expect(href).toBe(`${back}?fp_status=error&fp_master_id=${MASTER}&fp_code=${code}`);
    const { parseReturnParams } = await import('@/embed/contract');
    expect(parseReturnParams(new URL(href).search)).toEqual({ fp_status: 'error', fp_master_id: MASTER, fp_code: code });
  });

  it('a code with the wrong shape is left out rather than sent, and fp_code only travels with error', () => {
    expect(returnTarget(back, 'error', MASTER, 'not a code')).toBe(`${back}?fp_status=error&fp_master_id=${MASTER}`);
    expect(returnTarget(back, 'saved', MASTER, 'NOT_FOUND')).toBe(`${back}?fp_status=saved&fp_master_id=${MASTER}`);
    expect(returnTarget(back, 'cancelled')).toBe(`${back}?fp_status=cancelled`);
  });
});

describe('REMOVAL_COUNT_CHANGED details', () => {
  it('reads the field and the new count, and nothing from other errors', () => {
    expect(removalCountChangedOf(fail(409, 'REMOVAL_COUNT_CHANGED', envelope('REMOVAL_COUNT_CHANGED', { details: { field_id: 'f1', actual: 5 } })))).toEqual({ fieldId: 'f1', actual: 5 });
    expect(removalCountChangedOf(fail(409, 'REMOVAL_COUNT_CHANGED', envelope('REMOVAL_COUNT_CHANGED')))).toEqual({ fieldId: null, actual: null });
    expect(removalCountChangedOf(fail(409, 'REMOVAL_COUNT_CHANGED', envelope('REMOVAL_COUNT_CHANGED', { details: { field_id: 'f1', actual: -2 } })))).toEqual({ fieldId: 'f1', actual: null });
    expect(removalCountChangedOf(fail(409, 'MASTER_CHANGED'))).toBeNull();
    expect(removalCountChangedOf(new Error('x'))).toBeNull();
  });
});
