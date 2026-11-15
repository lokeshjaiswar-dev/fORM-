import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '@form/db';
import type { SearchIndex, SqlExecutor } from '@form/ports';
import { ProblemError } from '../errors.ts';
import { searchIndexOn, type SearchIndexFactory, type SearchTenantRunner } from './search.ts';

describe('searchIndexOn', () => {
  const executed: unknown[] = [];
  const tx = {
    execute: vi.fn(async (query: unknown) => {
      executed.push(query);
      return { rows: [{ ok: true }] };
    }),
  } as unknown as Tx;

  it('answers 503 when the app was built without a search index, so nothing is read or removed without it', () => {
    let thrown: unknown;
    try {
      searchIndexOn(undefined, tx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProblemError);
    expect(thrown).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('gives the factory a runner on the transaction it was bound to, whatever org it is asked for', async () => {
    const index = {} as SearchIndex;
    let runner: SearchTenantRunner | undefined;
    const factory: SearchIndexFactory = (o) => {
      runner = o.inTenant;
      return index;
    };
    expect(searchIndexOn(factory, tx)).toBe(index);
    const rows = await runner!('0190f5a2-7c1e-7a00-8000-000000000001', async (sql: SqlExecutor) => (await sql.executeSql('select 1')).rows);
    // The statement ran on the caller's transaction, not on a transaction of its own.
    expect(rows).toEqual([{ ok: true }]);
    expect(executed).toHaveLength(1);
  });
});
