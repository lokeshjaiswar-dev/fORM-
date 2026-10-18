import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations } from './migrate.ts';
import { roleUrl } from './provision.ts';

const dirs: string[] = [];

async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fr-migrations-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body);
  return dir;
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('loadMigrations', () => {
  it('loads the shipped migrations in order', async () => {
    const all = await loadMigrations();
    expect(all.map((m) => m.version)).toEqual(all.map((_, i) => i + 1));
    expect(all[0]?.name).toBe('foundation');
    expect(all.every((m) => /^[0-9a-f]{64}$/.test(m.checksum) && !m.sql.includes('\r'))).toBe(true);
  });

  it('gives the same checksum for CRLF and LF checkouts', async () => {
    const [lf] = await loadMigrations(await dirWith({ '0001_a.sql': 'select 1;\nselect 2;\n' }));
    const [crlf] = await loadMigrations(await dirWith({ '0001_a.sql': 'select 1;\r\nselect 2;\r\n' }));
    expect(crlf?.checksum).toBe(lf?.checksum);
  });

  it('rejects bad names and gaps', async () => {
    await expect(loadMigrations(await dirWith({ '1_a.sql': '' }))).rejects.toThrow(/bad file name/);
    await expect(loadMigrations(await dirWith({ '0001_a.sql': '', '0003_c.sql': '' }))).rejects.toThrow(/expected version 2/);
  });
});

describe('roleUrl', () => {
  it('swaps the user, password and database of a server URL', () => {
    expect(roleUrl('postgres://postgres:pw@db.local:5433/postgres?sslmode=require', 'fr_app', 'p@ss/w', 'form')).toBe(
      'postgres://fr_app:p%40ss%2Fw@db.local:5433/form?sslmode=require',
    );
  });
});
