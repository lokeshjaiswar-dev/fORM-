import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Executor } from '@form/db';
import { formTimeZone, issueSerials, serialFields, serialResponse, withSerials, withoutSerialBlocks, type IssuedSerial } from './uniqueIds.ts';

const dialect = new PgDialect();

/** A transaction stand-in that hands out 1, 2, 3… per (block, period) and records the bound parameters. */
function fakeCounter(): { tx: Executor; calls: unknown[][] } {
  const counters = new Map<string, number>();
  const calls: unknown[][] = [];
  const tx = {
    execute: async (query: SQL) => {
      const { params } = dialect.sqlToQuery(query);
      calls.push(params);
      const [, , blockId, period, startAt] = params as [string, string, string, string, number];
      const key = `${blockId}|${period}`;
      const next = Math.max((counters.get(key) ?? startAt - 1) + 1, startAt);
      counters.set(key, next);
      return { rows: [{ value: String(next) }] };
    },
  } as unknown as Executor;
  return { tx, calls };
}

const block = (id: string, config: Record<string, unknown>, key = id) => ({ id, key, type: 'unique_id', config });

describe('serialFields', () => {
  it('finds unique_id blocks, ordered by id, and ignores everything else', () => {
    const fields = serialFields({
      b: block('blk_b', { prefix: ['B-'], padTo: 3, startAt: 1, resetEvery: 'never', showOnEnding: true }),
      t: { id: 'blk_t', key: 'name', type: 'short_text', config: {} },
      a: block('blk_a', { prefix: [], padTo: 1, startAt: 1, resetEvery: 'month', showOnEnding: false }),
      junk: null,
    });
    expect(fields.map((f) => f.id)).toEqual(['blk_a', 'blk_b']);
    expect(fields[0]!.config.resetEvery).toBe('month');
  });

  it('keeps a well-formed config unchanged', () => {
    const config = { prefix: ['APP-'], padTo: 6, startAt: 1, resetEvery: 'year', showOnEnding: true };
    expect(serialFields({ x: block('blk_x', config) })[0]!.config).toEqual(config);
  });

  it('reads the label as plain text for a readable row', () => {
    const label = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ticket ' }, { type: 'text', text: 'no.' }] }] };
    expect(serialFields({ x: { ...block('blk_x', {}, 'ticket'), label } })[0]!.label).toBe('Ticket no.');
  });

  it('reads a broken draft config as safe defaults', () => {
    const [field] = serialFields({ x: block('blk_x', { prefix: 'nope', padTo: 0, startAt: -4, resetEvery: 'weekly' }) });
    expect(field!.config).toEqual({ prefix: [], padTo: 1, startAt: 1, resetEvery: 'never', showOnEnding: false });
    expect(serialFields({ x: block('blk_x', { padTo: 10_000 }) })[0]!.config.padTo).toBe(32);
    expect(serialFields(undefined)).toEqual([]);
  });
});

describe('issueSerials', () => {
  const at = new Date('2026-11-23T10:00:00Z');

  it('formats the Auto increment default as 1, 2', async () => {
    const { tx } = fakeCounter();
    const fields = serialFields({ n: block('blk_n', { prefix: [], padTo: 1, startAt: 1, resetEvery: 'never', showOnEnding: false }, 'number_1') });
    const input = { orgId: 'org', formId: 'form', fields, timeZone: 'Asia/Kolkata', at };
    const first = await issueSerials(tx, input);
    const second = await issueSerials(tx, input);
    expect(first).toEqual([{ blockId: 'blk_n', key: 'number_1', label: 'number_1', value: '1', showOnEnding: false }]);
    expect(second[0]!.value).toBe('2');
  });

  it('pads and prefixes like the preview did', async () => {
    const { tx } = fakeCounter();
    const fields = serialFields({ n: block('blk_app', { prefix: ['APP-', { pipe: { ref: 'x' } }], padTo: 6, startAt: 41, resetEvery: 'never', showOnEnding: true }) });
    const issued = await issueSerials(tx, { orgId: 'org', formId: 'form', fields, timeZone: 'UTC', at });
    expect(issued[0]!.value).toBe('APP-000041');
  });

  it('draws from the period of the form time zone', async () => {
    const { tx, calls } = fakeCounter();
    const fields = serialFields({
      m: block('blk_m', { prefix: [], padTo: 1, startAt: 1, resetEvery: 'month', showOnEnding: false }),
      y: block('blk_y', { prefix: [], padTo: 1, startAt: 1, resetEvery: 'year', showOnEnding: false }),
    });
    await issueSerials(tx, { orgId: 'org', formId: 'form', fields, timeZone: 'Asia/Kolkata', at: new Date('2026-12-31T20:00:00Z') });
    expect(calls.map((params) => params[3])).toEqual(['2027-01', '2027']);
  });
});

describe('withSerials', () => {
  const issued: IssuedSerial[] = [{ blockId: 'blk_n', key: 'ref', label: 'Reference', value: 'APP-000002', showOnEnding: true }];

  it('replaces the client preview in answers and readable rows without touching the input', () => {
    const answers = { blk_n: { type: 'unique_id', value: 'APP-000001' }, blk_t: { type: 'short_text', value: 'Asha' } };
    const fields = [
      { key: 'ref', label: 'Reference', value: 'APP-000001' },
      { key: 'name', label: 'Name', value: 'Asha' },
    ];
    const out = withSerials(answers, fields, issued);
    expect(out.answers).toEqual({ blk_n: { type: 'unique_id', value: 'APP-000002' }, blk_t: { type: 'short_text', value: 'Asha' } });
    expect(out.fields).toEqual([
      { key: 'ref', label: 'Reference', value: 'APP-000002' },
      { key: 'name', label: 'Name', value: 'Asha' },
    ]);
    expect(answers.blk_n.value).toBe('APP-000001');
    expect(fields[0]!.value).toBe('APP-000001');
  });

  it('stores the value and a readable row even when the client sent neither', () => {
    const out = withSerials({}, [{ key: 'name', label: 'Name', value: 'Asha' }], issued);
    expect(out.answers).toEqual({ blk_n: { type: 'unique_id', value: 'APP-000002' } });
    expect(out.fields).toEqual([
      { key: 'name', label: 'Name', value: 'Asha' },
      { key: 'ref', label: 'Reference', value: 'APP-000002' },
    ]);
  });
});

describe('serialResponse', () => {
  it('returns nothing for a form without unique ids', () => {
    expect(serialResponse([])).toEqual({});
  });

  it('shows the first showOnEnding value and lists every value by block', () => {
    expect(
      serialResponse([
        { blockId: 'blk_a', key: 'a', label: 'A', value: '7', showOnEnding: false },
        { blockId: 'blk_b', key: 'b', label: 'B', value: 'T-07', showOnEnding: true },
      ]),
    ).toEqual({ uniqueId: 'T-07', uniqueIds: { blk_a: '7', blk_b: 'T-07' } });
    expect(serialResponse([{ blockId: 'blk_a', key: 'a', label: 'A', value: '7', showOnEnding: false }])).toEqual({ uniqueIds: { blk_a: '7' } });
  });
});

describe('helpers', () => {
  it('reads the form time zone, defaulting to UTC', () => {
    expect(formTimeZone({ behavior: { timeZone: 'Asia/Kolkata' } })).toBe('Asia/Kolkata');
    expect(formTimeZone({ behavior: {} })).toBe('UTC');
    expect(formTimeZone(null)).toBe('UTC');
  });

  it('drops unique_id blocks before the uniqueness check', () => {
    const blocks = { a: { type: 'unique_id' }, b: { type: 'short_text' }, c: undefined };
    expect(Object.keys(withoutSerialBlocks(blocks))).toEqual(['b', 'c']);
  });
});
