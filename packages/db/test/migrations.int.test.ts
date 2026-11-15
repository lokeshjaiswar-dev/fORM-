import { randomUUID } from 'node:crypto';
import { getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createTestDatabase } from '@form/testkit';
import { bootstrapDatabase, loadMigrations, migrate, ROLES, roleUrl, tables } from '../src/index.ts';
import { failure, setupTestDb, type TestDb } from './harness.ts';
import { publicTables } from './isolation.ts';
import { TEST_PASSWORDS } from './passwords.ts';

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

  it('cover every table in public: a table without a definition would escape the column check above', async () => {
    expect(Object.values(tables).map((table) => getTableConfig(table).name).sort()).toEqual(await publicTables(t));
  });

  it('put the columns migration 0020 added to form_versions after the ones 0013 and 0017 made', async () => {
    const { rows } = await t.owner.query<{ name: string }>(
      `select a.attname as name from pg_attribute a where a.attrelid = 'public.form_versions'::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`,
    );
    expect(rows.map((r) => r.name).slice(-6)).toEqual(['media', 'label', 'engine', 'draft_rev', 'template_lineage', 'variables_snapshot']);
    expect(getTableConfig(tables.formVersions).columns.map((c) => c.name)).toEqual(rows.map((r) => r.name));
  });
});

describe('migration 0020 on a database that holds forms', () => {
  /** A database migrated up to 0019 and filled the way the prototype filled it, then migrated to 0020. */
  async function migratedFromPrototype() {
    const adminUrl = inject('pgAdminUrl');
    const database = await createTestDatabase(adminUrl);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await bootstrapDatabase(admin, database);
    } finally {
      await admin.end();
    }
    const c = new pg.Client({ connectionString: roleUrl(adminUrl, ROLES.migrator, TEST_PASSWORDS.migrator, database) });
    await c.connect();
    const files = await loadMigrations();
    expect((await migrate(c, files.filter((m) => m.version <= 19))).version).toBe(19);

    const org = randomUUID();
    const user = randomUUID();
    const team = randomUUID();
    await c.query(`insert into orgs (id, slug, name) values ($1, 'legacy', 'Legacy')`, [org]);
    await c.query(`insert into users (id, email, email_norm, password_hash) values ($1, 'o@legacy.test', 'o@legacy.test', 'x')`, [user]);
    const form = async (title: string, slug: string | null, submissions: number) => {
      const id = randomUUID();
      await c.query('insert into forms (id, org_id, team_id, owner_user_id, title, slug, submission_count) values ($1, $2, $3, $4, $5, $6, $7)', [id, org, team, user, title, slug, submissions]);
      return id;
    };
    const versions = async (formId: string, publishedAt: string[]) => {
      const ids: string[] = [];
      for (const [i, at] of publishedAt.entries()) {
        const id = randomUUID();
        ids.push(id);
        await c.query(
          `insert into form_versions (id, org_id, form_id, number, schema_version, published_at, published_by, definition, compiled, content_hash) values ($1, $2, $3, $4, 2, $5, $6, '{"title":"x"}', '{}', 'hash')`,
          [id, org, formId, i + 1, at, user],
        );
      }
      await c.query('update forms set live_version_id = $1 where id = $2', [ids.at(-1), formId]);
      return ids;
    };
    const published = await form('Published three times', 'published-three-times', 7);
    const publishedVersions = await versions(published, ['2026-10-01T10:00:00Z', '2026-10-05T10:00:00Z', '2026-10-09T10:00:00Z']);
    const once = await form('Published once', 'published-once', 0);
    const onceVersions = await versions(once, ['2026-10-02T10:00:00Z']);
    const draft = await form('Never published', null, 0);
    const unpublished = await form('Slug without a version', 'slug-without-version', 3);

    // Only 0020: later migrations are the business of their own tests.
    const result = await migrate(c, files.filter((m) => m.version <= 20));
    return { c, org, published, publishedVersions, once, onceVersions, draft, unpublished, result };
  }

  it('registers the slugs, counts the submissions and dates the superseded versions of what is already there', async () => {
    const m = await migratedFromPrototype();
    try {
      expect(m.result.applied).toEqual(['0020_form_ops']);
      const slugs = await m.c.query<{ slug: string; form_id: string; is_primary: boolean }>('select slug, form_id, is_primary from form_slugs order by slug');
      expect(slugs.rows).toEqual([
        { slug: 'published-once', form_id: m.once, is_primary: true },
        { slug: 'published-three-times', form_id: m.published, is_primary: true },
        { slug: 'slug-without-version', form_id: m.unpublished, is_primary: true },
      ]);
      const counters = await m.c.query<{ form_id: string; org_id: string; submitted_total: string }>('select form_id, org_id, submitted_total::text from form_counters');
      expect(Object.fromEntries(counters.rows.map((r) => [r.form_id, r.submitted_total]))).toEqual({
        [m.published]: '7',
        [m.once]: '0',
        [m.draft]: '0',
        [m.unpublished]: '3',
      });
      expect(counters.rows.every((r) => r.org_id === m.org)).toBe(true);
      const state = await m.c.query<{ version_id: string; superseded_at: Date | null; retired_at: Date | null }>('select version_id, superseded_at, retired_at from form_version_state');
      const by = Object.fromEntries(state.rows.map((r) => [r.version_id, r]));
      expect(state.rows).toHaveLength(4);
      // Superseded when the next version was published; the live version of each form is not.
      expect(by[m.publishedVersions[0]!]!.superseded_at?.toISOString()).toBe('2026-10-05T10:00:00.000Z');
      expect(by[m.publishedVersions[1]!]!.superseded_at?.toISOString()).toBe('2026-10-09T10:00:00.000Z');
      expect(by[m.publishedVersions[2]!]!.superseded_at).toBeNull();
      expect(by[m.onceVersions[0]!]!.superseded_at).toBeNull();
      expect(state.rows.every((r) => r.retired_at === null)).toBe(true);
    } finally {
      await m.c.end();
    }
  });

  it('gives the versions already published the new columns’ defaults, and then refuses to change them', async () => {
    const m = await migratedFromPrototype();
    try {
      const { rows } = await m.c.query('select label, engine, draft_rev, template_lineage, variables_snapshot, media from form_versions where form_id = $1 order by number', [m.published]);
      expect(rows).toHaveLength(3);
      for (const r of rows) expect(r).toEqual({ label: null, engine: 'logic@2', draft_rev: null, template_lineage: [], variables_snapshot: {}, media: null });
      expect(String(await failure(m.c.query(`update form_versions set content_hash = 'x' where form_id = $1`, [m.published])))).toMatch(/immutable/);
      expect(String(await failure(m.c.query('delete from form_versions where form_id = $1', [m.once])))).toMatch(/immutable/);
      // The registry resolves the migrated slug of a published form, to itself.
      const resolved = await m.c.query('select org_id, form_id, live_version_id, primary_slug from resolve_form_slug($1)', ['published-three-times']);
      expect(resolved.rows).toEqual([{ org_id: m.org, form_id: m.published, live_version_id: m.publishedVersions[2], primary_slug: 'published-three-times' }]);
    } finally {
      await m.c.end();
    }
  });
});
