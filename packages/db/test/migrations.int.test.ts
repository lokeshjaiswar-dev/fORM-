import { getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate, tables } from '../src/index.ts';
import { failure, setupTestDb, type TestDb } from './harness.ts';

let t: TestDb;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(() => t?.close());

async function asMigrator<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: t.urls.fr_migrator });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe('migrations', () => {
  it('are recorded with checksums and re-running applies nothing', async () => {
    const files = await loadMigrations();
    const { rows } = await t.owner.query<{ version: number; checksum: string }>('select version, checksum from fr_meta.schema_migrations order by version');
    expect(rows).toEqual(files.map((m) => ({ version: m.version, checksum: m.checksum })));
    expect(await asMigrator((c) => migrate(c))).toEqual({ applied: [], version: files.length });
  });

  it('serialise concurrent runs under the advisory lock', async () => {
    const results = await Promise.all([asMigrator((c) => migrate(c)), asMigrator((c) => migrate(c))]);
    expect(results.every((r) => r.applied.length === 0)).toBe(true);
  });

  it('refuse to run when an applied migration changed', async () => {
    const files = await loadMigrations();
    const edited = files.map((m, i) => (i === 0 ? { ...m, checksum: 'f'.repeat(64) } : m));
    expect(String(await failure(asMigrator((c) => migrate(c, edited))))).toMatch(/0001_foundation changed after it was applied/);
  });

  it('refuse to run when the database is ahead of the build', async () => {
    const files = await loadMigrations();
    expect(String(await failure(asMigrator((c) => migrate(c, files.slice(0, 2)))))).toMatch(/does not know/);
  });

  it('roll back a failing migration as a whole', async () => {
    const files = await loadMigrations();
    const broken = [...files, { version: files.length + 1, name: 'broken', sql: 'create table half_done (id int); select 1/0;', checksum: 'x' }];
    expect(String(await failure(asMigrator((c) => migrate(c, broken))))).toMatch(/broken failed: division by zero/);
    const { rows } = await t.owner.query(`select to_regclass('public.half_done') as t`);
    expect(rows[0]).toEqual({ t: null });
  });
});

describe('drizzle definitions', () => {
  it('match the migrated tables column for column', async () => {
    for (const table of Object.values(tables)) {
      const config = getTableConfig(table);
      const { rows } = await t.owner.query<{ name: string; type: string; not_null: boolean }>(
        `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null
         from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`,
        [`public.${config.name}`],
      );
      const expected = config.columns.map((c) => ({ name: c.name, type: c.getSQLType(), not_null: c.notNull }));
      expect(rows, config.name).toEqual(expected);
    }
  });
});
