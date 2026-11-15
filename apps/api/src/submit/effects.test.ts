import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '@form/ports';
import type { JobName, JobRequest, Queue, SearchDocument, SearchIndex } from '@form/ports';
import type { Tx } from '@form/db';
import type { Answers, FormDefinition } from '@form/schema';
import { answers as answersOf, definitionOf, encrypted, fieldBlock, sensitive } from '../submissions/test-fixtures.ts';
import type { SearchIndexFactory } from '../submissions/search.ts';
import { recordEffects, takeUniqueIds, type EffectsContext } from './effects.ts';

const dialect = new PgDialect();

/** A transaction that records the statements it is given (as SQL text and parameters) and answers with `reply`. */
function fakeTx(reply: (sql: string, params: unknown[]) => unknown[] = () => []) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    execute: vi.fn(async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const { sql, params } = dialect.sqlToQuery(query);
      statements.push({ sql, params });
      return { rows: reply(sql, params) };
    }),
  } as unknown as Tx;
  return { tx, statements };
}

const ORG = '11111111-1111-4111-8111-111111111111';
const FORM = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';
const SUBMISSION = '018f0000-0000-7000-8000-000000000001';
const RECEIVED = new Date('2026-11-15T10:00:00.000Z');

const uniqueId = (id: string, over: Record<string, unknown> = {}) =>
  ({ ...fieldBlock(id, 'short_text'), type: 'unique_id', config: { prefix: ['APP-'], padTo: 4, startAt: 100, resetEvery: 'never', showOnEnding: true, ...over } }) as unknown as ReturnType<typeof fieldBlock>;

function context(def: FormDefinition, values: Answers, over: Partial<EffectsContext> = {}): EffectsContext {
  return {
    orgId: ORG,
    formId: FORM,
    formVersionId: VERSION,
    versionNumber: 1,
    submissionId: SUBMISSION,
    receivedAt: RECEIVED,
    status: 'complete',
    locale: 'en-IN',
    answers: values,
    definition: def,
    compiled: { taint: {} } as unknown as EffectsContext['compiled'],
    ...over,
  };
}

/** A queue that keeps what it was sent and the executor it was told to send through. */
function fakeQueue(id: string | null = 'job-1') {
  const sent: Array<{ name: JobName; job: JobRequest<JobName>; tx: SqlExecutor | undefined }> = [];
  const queue: Queue = {
    send: vi.fn(async (name, job, o) => {
      sent.push({ name, job: job as JobRequest<JobName>, tx: o?.tx });
      return id;
    }) as Queue['send'],
    work: vi.fn() as unknown as Queue['work'],
    schedule: vi.fn() as unknown as Queue['schedule'],
    unschedule: vi.fn() as unknown as Queue['unschedule'],
  };
  return { queue, sent };
}

/** A search index factory that keeps the documents it is given and runs one statement through the transaction it is bound to. */
function fakeSearch() {
  const docs: Array<{ orgId: string; doc: SearchDocument }> = [];
  const factory: SearchIndexFactory = ({ inTenant }) =>
    ({
      upsert: async (orgId, batch) => {
        await inTenant(orgId, (sql) => sql.executeSql('select 1'));
        for (const doc of batch) docs.push({ orgId, doc });
      },
      remove: async () => {},
      query: async () => ({ hits: [] }),
    }) satisfies SearchIndex;
  return { factory, docs };
}

describe('recordEffects: the search document', () => {
  const def = definitionOf([fieldBlock('name', 'short_text'), sensitive(fieldBlock('pan', 'short_text')), encrypted(fieldBlock('phone', 'short_text')), fieldBlock('city', 'short_text')]);
  const values = answersOf({
    name: ['short_text', 'Asha Rao'],
    pan: ['short_text', 'ABCDE1234F'],
    phone: ['short_text', '9876543210'],
    city: ['short_text', 'Pune'],
  });

  it('writes the text of the plain answers, never an encrypt or sensitive field, on the submit transaction', async () => {
    const { tx, statements } = fakeTx();
    const search = fakeSearch();
    await recordEffects(tx, context(def, values), { searchIndex: search.factory });
    expect(search.docs).toEqual([
      { orgId: ORG, doc: { submissionId: SUBMISSION, receivedAt: '2026-11-15T10:00:00.000Z', formId: FORM, locale: 'en-IN', text: ['Asha Rao', 'Pune'] } },
    ]);
    expect(JSON.stringify(search.docs)).not.toMatch(/ABCDE|9876/);
    // The index ran its statement on this transaction, not on a connection of its own.
    expect(statements.map((s) => s.sql)).toEqual(['select 1']);
  });

  it('leaves out a value derived from a sensitive one (taint), and keeps one derived from a personal one', async () => {
    const calc = definitionOf([fieldBlock('name', 'short_text'), fieldBlock('score', 'short_text'), fieldBlock('copy', 'short_text')]);
    const derived = answersOf({ name: ['short_text', 'Asha'], score: ['short_text', 'from-the-pan'], copy: ['short_text', 'from-the-name'] });
    const taint = { 'value:score': { classification: 'sensitive', purposeIds: ['pur_1'] }, 'value:copy': { classification: 'personal', purposeIds: ['pur_1'] } };
    const search = fakeSearch();
    await recordEffects(fakeTx().tx, context(calc, derived, { compiled: { taint } as unknown as EffectsContext['compiled'] }), { searchIndex: search.factory });
    expect(search.docs[0]?.doc.text).toEqual(['Asha', 'from-the-name']);
  });

  it('indexes a held response at once (it is stored), whatever its status', async () => {
    const search = fakeSearch();
    await recordEffects(fakeTx().tx, context(def, values, { status: 'pending_payment' }), { searchIndex: search.factory });
    expect(search.docs).toHaveLength(1);
  });
});

describe('recordEffects: the one submission.fanout job', () => {
  const def = definitionOf([fieldBlock('name', 'short_text')]);
  const values = answersOf({ name: ['short_text', 'Asha'] });

  it('sends exactly one signed-by-the-queue job through the submit transaction: the form as its resource, ids only', async () => {
    const { tx, statements } = fakeTx();
    const { queue, sent } = fakeQueue();
    await recordEffects(tx, context(def, values), { queue });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      name: 'submission.fanout',
      job: { orgId: ORG, resource: { type: 'form', id: FORM }, data: { submissionId: SUBMISSION, receivedAt: '2026-11-15T10:00:00.000Z', event: 'created' } },
    });
    // Ids only: not one answer value travels in the job.
    expect(JSON.stringify(sent[0]!.job)).not.toContain('Asha');
    expect(Object.keys((sent[0]!.job as JobRequest<'submission.fanout'>).data).sort()).toEqual(['event', 'receivedAt', 'submissionId']);
    // `tx` is an executor over the transaction: a statement sent through it runs on it.
    await sent[0]!.tx!.executeSql('select $1::int as n', [1]);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toMatch(/select \$1::int as n/);
  });

  it.each(['pending_payment', 'payment_failed', 'pending_scan', 'pending_guardian_consent', 'spam', 'archived', 'trashed'] as const)(
    'sends nothing for a %s response: a held one is fanned out when it is released',
    async (status) => {
      const { queue, sent } = fakeQueue();
      await recordEffects(fakeTx().tx, context(def, values, { status }), { queue });
      expect(sent).toEqual([]);
    },
  );

  it('fails the transaction when the queue stored no job, so a response is never kept without its fan-out', async () => {
    await expect(recordEffects(fakeTx().tx, context(def, values), { queue: fakeQueue(null).queue })).rejects.toThrow(/submission\.fanout was not enqueued/);
  });

  it('skips an effect it was given no dependency for (an app built for a test), and does nothing without any', async () => {
    const { queue, sent } = fakeQueue();
    await recordEffects(fakeTx().tx, context(def, values), { queue });
    await recordEffects(fakeTx().tx, context(def, values), {});
    await recordEffects(fakeTx().tx, context(def, values));
    expect(sent).toHaveLength(1);
  });
});

describe('takeUniqueIds', () => {
  /** A counter table in memory: the number a statement for (form, block, period) takes. */
  function counters() {
    const next = new Map<string, number>();
    return fakeTx((sql, params) => {
      expect(sql).toMatch(/insert into form_id_counters as c/);
      expect(sql).toMatch(/on conflict \(form_id, block_id, period\) do update set next_seq = greatest\(c\.next_seq, \$6::bigint\) \+ 1\s+returning next_seq - 1 as taken/);
      const [formId, blockId, period, orgId, firstNext, startAt] = params as [string, string, string, string, number, number];
      expect(orgId).toBe(ORG);
      expect(firstNext).toBe(startAt + 1);
      const key = `${formId}/${blockId}/${period}`;
      const taken = Math.max(next.get(key) ?? 0, startAt);
      next.set(key, taken + 1);
      return [{ taken: String(taken) }];
    });
  }

  it('numbers a unique-ID block from startAt, formatted by the field type, and replaces what the page showed', async () => {
    const def = definitionOf([fieldBlock('name', 'short_text'), uniqueId('ticket')]);
    const { tx } = counters();
    const values = answersOf({ name: ['short_text', 'Asha'], ticket: ['unique_id', 'APP-0100'] });
    const first = await takeUniqueIds(tx, context(def, values));
    const second = await takeUniqueIds(tx, context(def, values));
    expect(first['ticket' as keyof Answers]).toEqual({ type: 'unique_id', value: 'APP-0100' });
    expect(second['ticket' as keyof Answers]).toEqual({ type: 'unique_id', value: 'APP-0101' });
    // Everything else is the answers as they came; the input is not changed.
    expect(first['name' as keyof Answers]).toEqual({ type: 'short_text', value: 'Asha' });
    expect(values['ticket' as keyof Answers]).toEqual({ type: 'unique_id', value: 'APP-0100' });
  });

  it('never takes the number the answers carry: a forged value is replaced by the counter’s', async () => {
    const def = definitionOf([uniqueId('ticket')]);
    const { tx } = counters();
    const forged = answersOf({ ticket: ['unique_id', 'APP-9999'] });
    expect((await takeUniqueIds(tx, context(def, forged)))['ticket' as keyof Answers]).toEqual({ type: 'unique_id', value: 'APP-0100' });
  });

  it('touches no counter for a form without a unique-ID block, nor for one the respondent’s path did not reach', async () => {
    const plain = definitionOf([fieldBlock('name', 'short_text')]);
    const none = fakeTx();
    const values = answersOf({ name: ['short_text', 'Asha'] });
    expect(await takeUniqueIds(none.tx, context(plain, values))).toBe(values);
    const hidden = definitionOf([fieldBlock('name', 'short_text'), uniqueId('ticket')]);
    expect(await takeUniqueIds(none.tx, context(hidden, values))).toBe(values);
    expect(none.statements).toEqual([]);
  });

  it('restarts the numbering with the period in the form’s own calendar: a year, a month, never', async () => {
    const yearly = definitionOf([uniqueId('ticket', { resetEvery: 'year', startAt: 1, padTo: 3 })]);
    const monthly = definitionOf([uniqueId('ticket', { resetEvery: 'month', startAt: 1, padTo: 3 })]);
    const never = definitionOf([uniqueId('ticket', { resetEvery: 'never', startAt: 1, padTo: 3 })]);
    const values = answersOf({ ticket: ['unique_id', 'APP-001'] });
    const periods = async (def: FormDefinition, at: Date) => {
      const { tx, statements } = counters();
      await takeUniqueIds(tx, context(def, values, { receivedAt: at }));
      return statements.map((s) => s.params[2]);
    };
    // 20:00 UTC on 31 December is already 1 January in Asia/Kolkata (UTC+5:30), the zone of these forms.
    const newYearInIndia = new Date('2026-12-31T20:00:00.000Z');
    expect(await periods(yearly, newYearInIndia)).toEqual(['2027']);
    expect(await periods(monthly, newYearInIndia)).toEqual(['2027-01']);
    expect(await periods(yearly, new Date('2026-12-31T10:00:00.000Z'))).toEqual(['2026']);
    expect(await periods(monthly, new Date('2026-11-15T10:00:00.000Z'))).toEqual(['2026-11']);
    expect(await periods(never, newYearInIndia)).toEqual(['']);
  });

  it('numbers several blocks in id order, so two transactions lock the counter rows in the same order', async () => {
    const def = definitionOf([uniqueId('zeta', { prefix: ['Z-'], startAt: 1, padTo: 2 }), uniqueId('alpha', { prefix: ['A-'], startAt: 1, padTo: 2 })]);
    const { tx, statements } = counters();
    const out = await takeUniqueIds(tx, context(def, answersOf({ zeta: ['unique_id', 'Z-01'], alpha: ['unique_id', 'A-01'] })));
    expect(statements.map((s) => s.params[1])).toEqual(['alpha', 'zeta']);
    expect([out['alpha' as keyof Answers], out['zeta' as keyof Answers]]).toEqual([
      { type: 'unique_id', value: 'A-01' },
      { type: 'unique_id', value: 'Z-01' },
    ]);
  });

  it('lets a later version raise startAt, and never lowers the numbering below what was given out', async () => {
    const low = definitionOf([uniqueId('ticket', { startAt: 1, padTo: 4, prefix: [] })]);
    const high = definitionOf([uniqueId('ticket', { startAt: 1000, padTo: 4, prefix: [] })]);
    const { tx } = counters();
    const values = answersOf({ ticket: ['unique_id', '0001'] });
    const taken = async (def: FormDefinition) => ((await takeUniqueIds(tx, context(def, values)))['ticket' as keyof Answers] as { value: string }).value;
    expect(await taken(low)).toBe('0001');
    expect(await taken(low)).toBe('0002');
    expect(await taken(high)).toBe('1000');
    expect(await taken(low)).toBe('1001');
  });

  it('fails the transaction when the counter gives no number', async () => {
    const def = definitionOf([uniqueId('ticket')]);
    await expect(takeUniqueIds(fakeTx().tx, context(def, answersOf({ ticket: ['unique_id', 'APP-0100'] })))).rejects.toThrow(/returned no number/);
  });
});
