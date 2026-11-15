import { createHash, randomUUID } from 'node:crypto';
import { getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createTestDatabase } from '@form/testkit';
import { bootstrapDatabase, loadMigrations, migrate, newSubmissionKey, partitionsOf, rlsViolations, ROLES, roleUrl, tables, uuidV7Time } from '../src/index.ts';
import { failure, pgCode, setupTestDb, type TestDb } from './harness.ts';
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

describe('migration 0021 on a database that holds prototype submissions', () => {
  /** A database migrated to 0020 and filled the way the prototype filled it: forms, versions, responses and files. */
  async function prototypeAt20() {
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
    expect((await migrate(c, files.filter((m) => m.version <= 20))).version).toBe(20);

    const orgA = randomUUID();
    const orgB = randomUUID();
    const user = randomUUID();
    await c.query(`insert into orgs (id, slug, name) values ($1, 'legacy-a', 'Legacy A'), ($2, 'legacy-b', 'Legacy B')`, [orgA, orgB]);
    await c.query(`insert into users (id, email, email_norm, password_hash) values ($1, 'o@legacy21.test', 'o@legacy21.test', 'x')`, [user]);
    const form = async (org: string, title: string) => {
      const id = randomUUID();
      await c.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [id, org, randomUUID(), user, title]);
      return id;
    };
    const version = async (org: string, formId: string, number: number, contentHash: string) => {
      const id = randomUUID();
      await c.query(
        `insert into form_versions (id, org_id, form_id, number, schema_version, published_at, published_by, definition, compiled, content_hash) values ($1, $2, $3, $4, 2, now(), $5, '{}', '{}', $6)`,
        [id, org, formId, number, user, contentHash],
      );
      return id;
    };
    const HASHES = { v1: 'ab'.repeat(32), v2: 'cd'.repeat(32), v3: 'ef'.repeat(32), odd: 'not-a-hash' };
    // Live form: three versions, the second one is live (a later draft was never published).
    const live = await form(orgA, 'Live');
    const liveV = [await version(orgA, live, 1, HASHES.v1), await version(orgA, live, 2, HASHES.v2), await version(orgA, live, 3, HASHES.v3)];
    await c.query('update forms set live_version_id = $1 where id = $2', [liveV[1], live]);
    // Unpublished form: no live version, so its newest version is the one its responses are filed under.
    const unpublished = await form(orgA, 'Unpublished');
    const unpublishedV = [await version(orgA, unpublished, 1, HASHES.v1), await version(orgA, unpublished, 2, HASHES.odd)];
    const other = await form(orgB, 'Other org');
    const otherV = await version(orgB, other, 1, HASHES.v1);

    // `n` in the answers is how the test finds a row again once its id has changed. Inserted out of order on purpose.
    const rows = [
      { n: 5, org: orgB, form: other, at: '2026-11-10T09:00:00Z', locale: 'en-IN' },
      { n: 3, org: orgA, form: live, at: '2026-10-15T08:30:00.123456Z', locale: 'en-IN' },
      { n: 1, org: orgA, form: live, at: '2026-09-30T23:59:59.999999Z', locale: 'en-IN' },
      { n: 4, org: orgA, form: unpublished, at: '2026-11-02T10:00:00.5Z', locale: 'ta-IN' },
      { n: 2, org: orgA, form: live, at: '2026-10-01T00:00:00Z', locale: 'hi-IN' },
    ];
    const oldIds: Record<number, string> = {};
    for (const r of rows) {
      oldIds[r.n] = randomUUID();
      await c.query(`insert into form_submissions (id, org_id, form_id, answers, fields, locale, submitted_at) values ($1, $2, $3, $4, '[{"key":"n","label":"N","value":"x"}]', $5, $6)`, [
        oldIds[r.n],
        r.org,
        r.form,
        JSON.stringify({ n: { type: 'number', value: r.n } }),
        r.locale,
        r.at,
      ]);
    }
    const file = async (name: string, org: string, formId: string, heldBy: number | null) => {
      const id = randomUUID();
      await c.query(
        `insert into form_files (id, org_id, form_id, block_id, name, mime, size_bytes, sha256, submission_id) values ($1, $2, $3, 'cv', $4, 'application/pdf', 4, $5, $6)`,
        [id, org, formId, name, '0'.repeat(64), heldBy === null ? null : oldIds[heldBy]],
      );
      return id;
    };
    const f = {
      held1: await file('held-by-1.pdf', orgA, live, 1),
      held3: await file('held-by-3.pdf', orgA, live, 3),
      stray: await file('never-held.pdf', orgA, live, null),
      held4: await file('held-by-4.pdf', orgA, unpublished, 4),
    };
    const counters = async () =>
      (await c.query<{ id: string; submission_count: number; last_submission_at: Date | null }>('select id, submission_count::int, last_submission_at from forms order by id')).rows;
    return { c, files, orgA, orgB, live, liveV, unpublished, unpublishedV, other, otherV, rows, oldIds, f, counters, HASHES };
  }

  it('moves every row with the form version it was received on, in the order it was received, and keeps what the forms counted', async () => {
    const m = await prototypeAt20();
    try {
      const countsBefore = await m.counters();
      expect(countsBefore.map((r) => r.submission_count).sort()).toEqual([1, 1, 3]);
      const result = await migrate(m.c, m.files.filter((x) => x.version <= 21));
      expect(result.applied).toEqual(['0021_submissions']);

      const { rows } = await m.c.query<{
        id: string;
        received_at: Date;
        org_id: string;
        form_id: string;
        form_version_id: string;
        hash: string;
        answer_codec_version: number;
        status: string;
        answers: { n: { value: number } };
        computed: unknown;
        meta: unknown;
        retention_ok: boolean;
        legal_hold: boolean;
        read: boolean;
        updated_at: Date;
        seq: string;
      }>(
        `select id, received_at, org_id, form_id, form_version_id, encode(definition_hash, 'hex') as hash, answer_codec_version, status, answers, computed, meta,
           delete_after = ((received_at at time zone 'UTC') + interval '10 years') at time zone 'UTC' as retention_ok, legal_hold, read, updated_at, seq::text
         from submissions order by seq`,
      );
      // seq follows the order they were received in, not the order they were inserted in.
      expect(rows.map((r) => r.answers.n.value)).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(rows.map((r) => r.seq)).size).toBe(5);
      const odd = createHash('sha256').update(m.HASHES.odd).digest('hex');
      const expected = [
        { n: 1, at: '2026-09-30T23:59:59.999Z', org: m.orgA, form: m.live, version: m.liveV[1], hash: m.HASHES.v2, locale: 'en-IN' },
        { n: 2, at: '2026-10-01T00:00:00.000Z', org: m.orgA, form: m.live, version: m.liveV[1], hash: m.HASHES.v2, locale: 'hi-IN' },
        { n: 3, at: '2026-10-15T08:30:00.123Z', org: m.orgA, form: m.live, version: m.liveV[1], hash: m.HASHES.v2, locale: 'en-IN' },
        { n: 4, at: '2026-11-02T10:00:00.500Z', org: m.orgA, form: m.unpublished, version: m.unpublishedV[1], hash: odd, locale: 'ta-IN' },
        { n: 5, at: '2026-11-10T09:00:00.000Z', org: m.orgB, form: m.other, version: m.otherV, hash: m.HASHES.v1, locale: 'en-IN' },
      ];
      for (const [i, e] of expected.entries()) {
        const r = rows[i]!;
        expect(r.id, `row ${e.n}`).not.toBe(m.oldIds[e.n]);
        expect(r.received_at.toISOString(), `row ${e.n}`).toBe(e.at);
        // The id is a UUIDv7 made from the moment the response was received.
        expect(uuidV7Time(r.id)?.toISOString(), `row ${e.n}`).toBe(e.at);
        expect(r, `row ${e.n}`).toMatchObject({
          org_id: e.org,
          form_id: e.form,
          form_version_id: e.version,
          hash: e.hash,
          answer_codec_version: 0,
          status: 'complete',
          retention_ok: true,
          legal_hold: false,
          read: false,
        });
        expect(r.computed, `row ${e.n}`).toEqual({});
        expect(r.meta, `row ${e.n}`).toEqual({ locale: e.locale });
        // The last change is when it was received (the prototype never edited a response).
        expect(r.updated_at.getTime(), `row ${e.n}`).toBe(new Date(m.rows.find((x) => x.n === e.n)!.at).getTime());
      }

      // The forms' counters were not counted again by the copy.
      expect(await m.counters()).toEqual(countsBefore);

      // The prototype table is gone, and its trigger with it; the new one counts and links from now on.
      expect((await m.c.query(`select to_regclass('public.form_submissions') as t`)).rows).toEqual([{ t: null }]);
      const triggers = await m.c.query<{ tgname: string; tgrelid: string }>(`select tgname, tgrelid::regclass::text from pg_trigger where tgname in ('form_submissions_recorded', 'submissions_recorded') and not tgisinternal and tgparentid = 0`);
      expect(triggers.rows).toEqual([{ tgname: 'submissions_recorded', tgrelid: 'submissions' }]);
    } finally {
      await m.c.end();
    }
  });

  it('points the files a submission held at its new key, leaves the others alone, and un-holds on delete', async () => {
    const m = await prototypeAt20();
    try {
      await migrate(m.c, m.files.filter((x) => x.version <= 21));
      const byAnswer = async (n: number) =>
        (await m.c.query<{ id: string; received_at: Date }>(`select id, received_at from submissions where (answers #>> '{n,value}')::int = $1`, [n])).rows[0]!;
      const held = async () =>
        Object.fromEntries(
          (await m.c.query<{ id: string; submission_id: string | null; submission_received_at: Date | null }>('select id, submission_id, submission_received_at from form_files')).rows.map((r) => [
            r.id,
            [r.submission_id, r.submission_received_at?.toISOString() ?? null],
          ]),
        );
      const [s1, s3, s4] = [await byAnswer(1), await byAnswer(3), await byAnswer(4)];
      expect(await held()).toEqual({
        [m.f.held1]: [s1.id, s1.received_at.toISOString()],
        [m.f.held3]: [s3.id, s3.received_at.toISOString()],
        [m.f.stray]: [null, null],
        [m.f.held4]: [s4.id, s4.received_at.toISOString()],
      });
      // The key is enforced: a file can name only a submission that exists, with its own moment.
      expect(pgCode(await failure(m.c.query('update form_files set submission_received_at = now() where id = $1', [m.f.held1])))).toBe('23503');
      expect(pgCode(await failure(m.c.query('update form_files set submission_id = null where id = $1', [m.f.held1])))).toBe('23514');
      // Deleting the submission un-holds its file by both columns, and touches no other file.
      await m.c.query('delete from submissions where id = $1 and received_at = $2', [s1.id, s1.received_at]);
      expect(await held()).toEqual({
        [m.f.held1]: [null, null],
        [m.f.held3]: [s3.id, s3.received_at.toISOString()],
        [m.f.stray]: [null, null],
        [m.f.held4]: [s4.id, s4.received_at.toISOString()],
      });
      // The moved trigger links an unheld file named by a later submission, and counts it.
      const before = (await m.c.query<{ n: number }>('select submission_count::int as n from forms where id = $1', [m.live])).rows[0]!.n;
      const later = newSubmissionKey(new Date());
      await m.c.query(
        `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta)
         values ($1, $2, $3, $4, $5, $6, 0, 'complete', $7, '{}', '{}')`,
        [later.id, later.receivedAt, m.orgA, m.live, m.liveV[1], Buffer.alloc(32), JSON.stringify({ cv: { type: 'file_upload', value: [{ fileId: m.f.stray, name: 'never-held.pdf' }] } })],
      );
      expect((await held())[m.f.stray]).toEqual([later.id, later.receivedAt.toISOString()]);
      expect((await m.c.query<{ n: number }>('select submission_count::int as n from forms where id = $1', [m.live])).rows[0]!.n).toBe(before + 1);
    } finally {
      await m.c.end();
    }
  });

  it('makes partitions for the months the old rows were received in, then the usual ones, and no default partition', async () => {
    const m = await prototypeAt20();
    try {
      await migrate(m.c, m.files.filter((x) => x.version <= 21));
      const names = (await partitionsOf(m.c, 'submissions')).map((p) => p.name);
      const { rows: expected } = await m.c.query<{ name: string }>(
        `select 'parts.submissions_' || to_char(d, 'YYYY_MM') as name
         from generate_series(timestamp '2026-09-01', date_trunc('month', now() at time zone 'UTC') + interval '3 months', interval '1 month') d order by 1`,
      );
      expect(names).toEqual(expected.map((e) => e.name));
      expect(names.slice(0, 3)).toEqual(['parts.submissions_2026_09', 'parts.submissions_2026_10', 'parts.submissions_2026_11']);
      for (const p of await partitionsOf(m.c, 'submissions')) expect(p, p.name).toMatchObject({ forced: true, owner: 'fr_migrator', grantees: ['fr_migrator'] });
      expect(await rlsViolations(m.c)).toEqual([]);
      // partitions.maintain carries on from here without clashing with what the migration made.
      expect((await m.c.query<{ name: string }>(`select create_partitions('public.submissions'::regclass, 3) as name`)).rows).toEqual([]);
    } finally {
      await m.c.end();
    }
  });

  it('refuses, and changes nothing, when a response belongs to a form that has no version', async () => {
    const m = await prototypeAt20();
    try {
      const bare = randomUUID();
      await m.c.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [bare, m.orgA, randomUUID(), randomUUID(), 'Never published']);
      await m.c.query(`insert into form_submissions (id, org_id, form_id, answers, fields) values ($1, $2, $3, '{}', '[]')`, [randomUUID(), m.orgA, bare]);
      const err = String(await failure(migrate(m.c, m.files.filter((x) => x.version <= 21))));
      expect(err).toMatch(/0021_submissions failed: 0021: 1 form_submissions row\(s\) belong to a form that has no version/);
      expect((await m.c.query(`select to_regclass('public.form_submissions') as old, to_regclass('public.submissions') as new`)).rows).toEqual([{ old: 'form_submissions', new: null }]);
      expect((await m.c.query<{ n: number }>('select count(*)::int as n from form_submissions')).rows[0]!.n).toBe(6);
      expect((await m.c.query<{ v: number }>('select max(version) as v from fr_meta.schema_migrations')).rows[0]!.v).toBe(20);
    } finally {
      await m.c.end();
    }
  });
});
