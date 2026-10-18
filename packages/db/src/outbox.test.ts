import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { textSql, txExecutor } from './outbox.ts';

const dialect = new PgDialect();
const render = (text: string, values: unknown[] = []) => {
  const { sql, params } = dialect.sqlToQuery(textSql(text, values));
  return { sql, params };
};

describe('textSql', () => {
  it('binds every $n, in any order and repeated, as its own parameter', () => {
    expect(render('select $2::int, $1::jsonb, $2::int', ['{"a":1}', 7])).toEqual({
      sql: 'select $1::int, $2::jsonb, $3::int',
      params: [7, '{"a":1}', 7],
    });
  });

  it('binds arrays whole', () => {
    expect(render('select * from t where id = any($1::uuid[])', [['a', 'b']])).toEqual({
      sql: 'select * from t where id = any($1::uuid[])',
      params: [['a', 'b']],
    });
  });

  it('leaves $n inside literals, identifiers and dollar quotes alone', () => {
    const text = `select '$1 it''s', "col$1", $$ $1 $$, $fn$ body $2 $fn$, $1`;
    expect(render(text, ['x'])).toEqual({ sql: text, params: ['x'] });
  });

  it('refuses a placeholder without a value', () => {
    expect(() => textSql('select $2', ['only one'])).toThrow(RangeError);
    expect(() => textSql('select $0', ['x'])).toThrow(RangeError);
  });

  it('runs on the transaction it wraps', async () => {
    const seen: unknown[] = [];
    const exec = txExecutor({
      execute: (async (q: Parameters<typeof dialect.sqlToQuery>[0]) => {
        const { sql, params } = dialect.sqlToQuery(q);
        seen.push({ sql, params });
        return { rows: [{ ok: 1 }] };
      }) as never,
    });
    expect(await exec.executeSql('select $1', [1])).toEqual({ rows: [{ ok: 1 }] });
    expect(await exec.executeSql('select 2')).toEqual({ rows: [{ ok: 1 }] });
    expect(seen).toEqual([
      { sql: 'select $1', params: [1] },
      { sql: 'select 2', params: [] },
    ]);
  });
});
