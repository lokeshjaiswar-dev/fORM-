import type { ReviewUnit } from '@form/schema';
import { describe, expect, it } from 'vitest';
import { MASK } from '../disclosure.ts';
import { buildExportPlan, FIXED_HEADERS, type ExportReviewer, type ExportVersion } from './columns.ts';
import { answered, compiledOf, definitionOf, field, personal, sensitive, type DefinitionOptions } from './test-forms.ts';

/*
 * The shape of an export file (WP-1.17 EXP-01): which columns, in which order, and what each response puts in them.
 * The rules about what may leave at all are `disclosableFields`' (tested in disclosure.test.ts); here they are checked as they
 * come out in a file: masked, omitted, across versions, and for a reviewer.
 */

const RECEIVED = new Date('2026-11-16T04:30:00.000Z');

function version(id: string, number: number, blocks: ReturnType<typeof field>[], o: DefinitionOptions = {}): ExportVersion {
  const definition = definitionOf(blocks, o);
  return { id, number, definition, compiled: compiledOf(definition) };
}

const response = (id: string, formVersionId: string, answers: Record<string, [string, unknown]>) => ({ id, receivedAt: RECEIVED, formVersionId, answers: answered(answers) });

describe('buildExportPlan: one version', () => {
  const blocks = [
    personal('name'),
    personal('pan', { classification: 'sensitive', encrypt: true, inNotifications: 'mask', inExports: 'mask' }),
    sensitive('ssn', 'omit'),
    field({ id: 'age', type: 'number' }),
    personal('who', {}, { type: 'full_name' }),
  ];
  const v1 = version('v1', 1, blocks);
  const answers: Record<string, [string, unknown]> = {
    name: ['short_text', 'Asha'],
    pan: ['short_text', 'ABCDE1234F'],
    ssn: ['short_text', '123-45-6789'],
    age: ['number', '31'],
    who: ['full_name', { first: 'Asha', last: 'Rao' }],
  };

  it('starts with the response id and the received-at time, then one column per export column of each exported field', () => {
    const plan = buildExportPlan({ versions: [v1], includeSensitive: false });
    expect(plan.headers.slice(0, 2)).toEqual([...FIXED_HEADERS]);
    expect(plan.headers).toContain('Label of name');
    expect(plan.headers).toContain('Label of who / first');
    expect(plan.headers).toContain('Label of who / last');
    expect(plan.fieldColumns).toBe(plan.headers.length - 2);
  });

  it('drops an omit column in every case and shows MASK for a mask column unless include_sensitive is set', () => {
    const masked = buildExportPlan({ versions: [v1], includeSensitive: false });
    expect(masked.headers.join('|')).not.toContain('ssn');
    const row = masked.rowOf(response('r1', 'v1', answers));
    expect(row.cells.slice(0, 2)).toEqual(['r1', RECEIVED.toISOString()]);
    const at = (header: string) => row.cells[masked.headers.indexOf(header)];
    expect(at('Label of name')).toBe('Asha');
    expect(at('Label of pan')).toBe(MASK);
    expect(at('Label of age')).toBe('31');
    expect(at('Label of who / first')).toBe('Asha');
    expect(at('Label of who / last')).toBe('Rao');
    expect(row.cells).not.toContain('123-45-6789');

    const shown = buildExportPlan({ versions: [v1], includeSensitive: true });
    expect(shown.headers.join('|')).not.toContain('ssn');
    const shownRow = shown.rowOf(response('r1', 'v1', answers));
    expect(shownRow.cells[shown.headers.indexOf('Label of pan')]).toBe('ABCDE1234F');
    expect(shownRow.cells).not.toContain('123-45-6789');
  });

  it('names in fieldKeys the fields whose value is in the row: not a masked one, not one that was left blank', () => {
    const plan = buildExportPlan({ versions: [v1], includeSensitive: false });
    const row = plan.rowOf(response('r1', 'v1', { name: ['short_text', 'Asha'], pan: ['short_text', 'ABCDE1234F'] }));
    expect(row.fieldKeys).toEqual(['name']);
    const withSensitive = buildExportPlan({ versions: [v1], includeSensitive: true }).rowOf(response('r1', 'v1', { name: ['short_text', 'Asha'], pan: ['short_text', 'ABCDE1234F'] }));
    expect(withSensitive.fieldKeys).toEqual(['name', 'pan']);
  });

  it('leaves a field the respondent did not answer blank, and a sealed answer is MASK even with include_sensitive', () => {
    const plan = buildExportPlan({ versions: [v1], includeSensitive: true });
    const row = plan.rowOf({ id: 'r2', receivedAt: RECEIVED, formVersionId: 'v1', answers: { name: { type: 'short_text', sealed: 'xyz' } } });
    expect(row.cells[plan.headers.indexOf('Label of name')]).toBe(MASK);
    expect(row.cells[plan.headers.indexOf('Label of age')]).toBe('');
    expect(row.fieldKeys).toEqual([]);
  });

  it('gives a response filed under a version the plan does not know the fixed cells and blanks, never another version\'s answers', () => {
    const plan = buildExportPlan({ versions: [v1], includeSensitive: false });
    const row = plan.rowOf(response('r3', 'unknown', answers));
    expect(row.cells).toHaveLength(plan.headers.length);
    expect(row.cells.slice(2).every((c) => c === '')).toBe(true);
    expect(row.fieldKeys).toEqual([]);
  });
});

describe('buildExportPlan: the union over versions', () => {
  const v1 = version('v1', 1, [personal('name', {}, { label: 'Name (old)' }), personal('old'), personal('phone')]);
  const v2 = version('v2', 2, [personal('name', {}, { label: 'Full name' }), personal('extra'), personal('phone', { inExports: 'omit' })]);

  it('takes the order and headers of the newest version, then the fields only older versions had', () => {
    const plan = buildExportPlan({ versions: [v1, v2], includeSensitive: false });
    expect(plan.headers).toEqual([...FIXED_HEADERS, 'Full name', 'Label of extra', 'Label of old']);
    // The order the versions are given in does not matter.
    expect(buildExportPlan({ versions: [v2, v1], includeSensitive: false }).headers).toEqual(plan.headers);
  });

  it('fills each response from its own version: a field it never had is blank', () => {
    const plan = buildExportPlan({ versions: [v1, v2], includeSensitive: false });
    const old = plan.rowOf(response('r1', 'v1', { name: ['short_text', 'Asha'], old: ['short_text', 'kept'] }));
    expect(old.cells.slice(2)).toEqual(['Asha', '', 'kept']);
    const current = plan.rowOf(response('r2', 'v2', { name: ['short_text', 'Ravi'], extra: ['short_text', 'new'] }));
    expect(current.cells.slice(2)).toEqual(['Ravi', 'new', '']);
  });

  it('a field the newest version omits is not in the file for the responses of older versions either', () => {
    const plan = buildExportPlan({ versions: [v1, v2], includeSensitive: false });
    expect(plan.headers.join('|')).not.toContain('phone');
    const row = plan.rowOf(response('r1', 'v1', { phone: ['short_text', '+919876543210'] }));
    expect(row.cells).not.toContain('+919876543210');
  });

  it('a field the newest version masks is MASK for older responses too', () => {
    const masking = version('v3', 3, [personal('name'), personal('old', { classification: 'sensitive', inExports: 'mask' })]);
    const plan = buildExportPlan({ versions: [v1, masking], includeSensitive: false });
    const old = plan.rowOf(response('r1', 'v1', { name: ['short_text', 'Asha'], old: ['short_text', 'secret-old'] }));
    expect(old.cells[plan.headers.indexOf('Label of old')]).toBe(MASK);
    expect(old.cells).not.toContain('secret-old');
    expect(old.fieldKeys).toEqual(['name']);
    // The opt-in shows it again, for both.
    const shown = buildExportPlan({ versions: [v1, masking], includeSensitive: true });
    expect(shown.rowOf(response('r1', 'v1', { old: ['short_text', 'secret-old'] })).cells).toContain('secret-old');
  });

  it('an older version that omitted a field blanks it for its own responses', () => {
    const omitting = version('v1', 1, [personal('name'), sensitive('pan', 'omit')]);
    const current = version('v2', 2, [personal('name'), personal('pan')]);
    const plan = buildExportPlan({ versions: [omitting, current], includeSensitive: false });
    expect(plan.headers).toContain('Label of pan');
    const old = plan.rowOf(response('r1', 'v1', { name: ['short_text', 'Asha'], pan: ['short_text', 'ABCDE1234F'] }));
    expect(old.cells).not.toContain('ABCDE1234F');
    const now = plan.rowOf(response('r2', 'v2', { name: ['short_text', 'Ravi'], pan: ['short_text', 'PQRST5678K'] }));
    expect(now.cells).toContain('PQRST5678K');
  });
});

describe('buildExportPlan: reviewer redaction (own_unit)', () => {
  const unit = (id: string, pageId: string): ReviewUnit => ({ id, name: id, target: { kind: 'page', pageId } }) as unknown as ReviewUnit;
  const blocks = [personal('a1'), personal('a2'), personal('b1'), personal('b2'), personal('c1')];
  const v1 = version('v1', 1, blocks, {
    pages: [
      { id: 'pa', children: ['a1', 'a2'] },
      { id: 'pb', children: ['b1', 'b2'] },
      { id: 'pc', children: ['c1'] },
    ],
    review: [unit('u_a', 'pa'), unit('u_b', 'pb')],
  });
  const settings = {
    units: [
      { unitId: 'u_a', groupId: 'g_a', order: 1, required: true, visibility: 'own_unit' },
      { unitId: 'u_b', groupId: 'g_b', order: 1, required: true, visibility: 'own_unit' },
      { unitId: 'u_w', groupId: 'g_w', order: 1, required: true, visibility: 'whole_submission' },
    ],
  } as unknown as ExportReviewer['settings'];
  const all: Record<string, [string, unknown]> = {
    a1: ['short_text', 'A-one'],
    a2: ['short_text', 'A-two'],
    b1: ['short_text', 'B-one'],
    b2: ['short_text', 'B-two'],
    c1: ['short_text', 'C-one'],
  };
  const withGroups = (...groupIds: string[]): ExportReviewer => ({ settings, groupIds });

  it('a unit B checker has no unit A columns, and the blocks that are in no unit stay', () => {
    const plan = buildExportPlan({ versions: [v1], includeSensitive: false, reviewer: withGroups('g_b') });
    expect(plan.headers).toEqual([...FIXED_HEADERS, 'Label of b1', 'Label of b2', 'Label of c1']);
    const row = plan.rowOf(response('r1', 'v1', all));
    expect(row.cells.slice(2)).toEqual(['B-one', 'B-two', 'C-one']);
    expect(row.cells).not.toContain('A-one');
    expect(row.fieldKeys).toEqual(['b1', 'b2', 'c1']);
  });

  it('a requester who is in no review group has every column', () => {
    for (const reviewer of [null, undefined, withGroups(), withGroups('g_elsewhere')]) {
      const plan = buildExportPlan({ versions: [v1], includeSensitive: false, reviewer });
      expect(plan.headers).toEqual([...FIXED_HEADERS, 'Label of a1', 'Label of a2', 'Label of b1', 'Label of b2', 'Label of c1']);
    }
  });

  it('a checker whose group sees the whole submission has every column', () => {
    const plan = buildExportPlan({ versions: [v1], includeSensitive: false, reviewer: withGroups('g_w') });
    expect(plan.headers).toHaveLength(2 + 5);
  });

  it('a checker of two units sees both and not the third', () => {
    const plan = buildExportPlan({ versions: [v1], includeSensitive: false, reviewer: withGroups('g_a', 'g_b') });
    expect(plan.headers).toHaveLength(2 + 5);
  });

  it('redaction applies per version: an older version without units shows its fields only where the newest version has the column', () => {
    const older = version('v0', 0, [personal('a1'), personal('b1'), personal('x_old')]);
    const plan = buildExportPlan({ versions: [older, v1], includeSensitive: false, reviewer: withGroups('g_b') });
    // a1 is governed by v1, where it belongs to unit A: not in the file, so not for the older response either.
    expect(plan.headers.join('|')).not.toContain('a1');
    const row = plan.rowOf(response('r0', 'v0', { a1: ['short_text', 'A-old'], b1: ['short_text', 'B-old'], x_old: ['short_text', 'X-old'] }));
    expect(row.cells).not.toContain('A-old');
    expect(row.cells).toContain('B-old');
  });
});
