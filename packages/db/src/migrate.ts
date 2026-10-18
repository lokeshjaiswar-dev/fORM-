import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateResult {
  applied: string[];
  version: number;
}

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** pg_advisory_lock key shared by every migrator (`form-admin migrate`, the Helm migrate Job, tests). */
export const MIGRATION_LOCK_KEY = 7_316_420_013;

export function migrationsDir(): string {
  return fileURLToPath(new URL('../migrations/', import.meta.url));
}

const id = (m: Pick<Migration, 'version' | 'name'>) => `${String(m.version).padStart(4, '0')}_${m.name}`;

/** Reads `NNNN_name.sql` files in order. Line endings are normalised so checksums match on every OS. */
export async function loadMigrations(dir: string = migrationsDir()): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const m = FILE.exec(file);
    if (!m) throw new Error(`migrations: bad file name ${file} (expected NNNN_name.sql)`);
    const sql = (await readFile(path.join(dir, file), 'utf8')).replace(/\r\n/g, '\n');
    const version = Number(m[1]);
    if (version !== migrations.length + 1) throw new Error(`migrations: expected version ${migrations.length + 1}, found ${file}`);
    migrations.push({ version, name: m[2]!, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return migrations;
}

/**
 * Applies pending migrations, each in its own transaction, under an advisory lock. Refuses to run when an
 * applied migration changed or when the database has migrations this build does not know.
 */
export async function migrate(client: pg.ClientBase, migrations?: Migration[]): Promise<MigrateResult> {
  const all = migrations ?? (await loadMigrations());
  await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    await client.query(`create schema if not exists fr_meta;
      create table if not exists fr_meta.schema_migrations (
        version integer primary key,
        name text not null,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
    const { rows } = await client.query<{ version: number; name: string; checksum: string }>(
      'select version, name, checksum from fr_meta.schema_migrations order by version',
    );
    const known = new Map(all.map((m) => [m.version, m]));
    for (const row of rows) {
      const m = known.get(row.version);
      if (!m) throw new Error(`migrations: the database has ${id(row)}, which this build does not know`);
      if (m.name !== row.name || m.checksum !== row.checksum) throw new Error(`migrations: ${id(m)} changed after it was applied`);
    }
    const done = new Set(rows.map((r) => r.version));
    const applied: string[] = [];
    for (const m of all) {
      if (done.has(m.version)) continue;
      await client.query('begin');
      try {
        await client.query(m.sql);
        await client.query('insert into fr_meta.schema_migrations (version, name, checksum) values ($1, $2, $3)', [m.version, m.name, m.checksum]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migrations: ${id(m)} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      applied.push(id(m));
    }
    return { applied, version: Math.max(0, ...all.map((m) => m.version)) };
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  }
}
