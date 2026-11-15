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

  it('put the column migration 0022 added to org_settings after the ones 0008 made', async () => {
    const { rows } = await t.owner.query<{ name: string }>(
      `select a.attname as name from pg_attribute a where a.attrelid = 'public.org_settings'::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`,
    );
    expect(rows.map((r) => r.name)).toEqual(['org_id', 'editors_approve_notice', 'invite_days', 'updated_at', 'updated_by', 'review_checkers_mfa']);
    expect(getTableConfig(tables.orgSettings).columns.map((c) => c.name)).toEqual(rows.map((r) => r.name));
  });

  it('cover the five tables of migration 0022, the two partitioned ones included, with the columns it made', async () => {
    const named = (table: Parameters<typeof getTableConfig>[0]) => getTableConfig(table).columns.map((c) => c.name);
    expect(named(tables.reviewGroups)).toEqual(['id', 'org_id', 'name', 'created_by', 'created_at', 'archived_at']);
    expect(named(tables.reviewGroupMembers)).toEqual(['org_id', 'group_id', 'user_id', 'added_by', 'added_at']);
    expect(named(tables.formReviewSettings)).toEqual(['form_id', 'org_id', 'rev', 'enabled', 'settings', 'updated_by', 'updated_at']);
    expect(named(tables.submissionReviews)).toEqual([
      'org_id', 'form_id', 'submission_id', 'submission_received_at', 'unit_id', 'round', 'state', 'required', 'review_order', 'group_id',
      'visibility', 'maker_user_id', 'excluded_user_ids', 'last_editor_id', 'answers_hash', 'rev', 'updated_at',
    ]);
    expect(named(tables.reviewDecisions)).toEqual([
      'id', 'org_id', 'form_id', 'submission_id', 'submission_received_at', 'unit_id', 'round', 'decision', 'reason_code', 'decided_by',
      'decided_at', 'answers_hash', 'form_version_id', 'idempotency_key',
    ]);
    // The two partitioned parents are tables of relkind p, which the generic comparison above reads like any other.
    const { rows } = await t.owner.query<{ relname: string; relkind: string }>(
      `select relname, relkind from pg_class where relnamespace = 'public'::regnamespace and relname in ('submission_reviews', 'review_decisions') order by 1`,
    );
    expect(rows).toEqual([{ relname: 'review_decisions', relkind: 'p' }, { relname: 'submission_reviews', relkind: 'p' }]);
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

    // What the prototype stored next to the answers: display rows (the label and text of each answer as its page sent
    // them). Each response has its own, so a copy that mixed them up, shared one or dropped them shows; response 2 had none.
    const fieldsOf = (n: number): Array<{ key: string; label: string; value: string }> =>
      n === 2
        ? []
        : [
            { key: 'n', label: `Question ${n}`, value: `Answer ${n}` },
            { key: 'note', label: 'Note “with” quotes', value: `ünïcode ✓ ${n}\nsecond line` },
          ];
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
      await c.query(`insert into form_submissions (id, org_id, form_id, answers, fields, locale, submitted_at) values ($1, $2, $3, $4, $5, $6, $7)`, [
        oldIds[r.n],
        r.org,
        r.form,
        JSON.stringify({ n: { type: 'number', value: r.n } }),
        JSON.stringify(fieldsOf(r.n)),
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
    return { c, files, orgA, orgB, live, liveV, unpublished, unpublishedV, other, otherV, rows, oldIds, f, counters, HASHES, fieldsOf };
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

  it('carries each response’s display rows into legacy_fields as they were, and leaves the column null for a response taken afterwards', async () => {
    const m = await prototypeAt20();
    try {
      await migrate(m.c, m.files.filter((x) => x.version <= 21));
      const { rows } = await m.c.query<{ n: number; legacy_fields: unknown }>(
        `select (answers #>> '{n,value}')::int as n, legacy_fields from submissions order by seq`,
      );
      // Every moved response, in the order received, with the rows its own prototype row held: the labels and the text
      // (quotes, non-ASCII, a line break) unchanged, and response 2, which had none, an empty array and not null.
      expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5]);
      for (const r of rows) expect(r.legacy_fields, `response ${r.n}`).toEqual(m.fieldsOf(r.n));
      expect(rows.find((r) => r.n === 2)!.legacy_fields).toEqual([]);

      // Not null is what marks prototype data: a response the submit route takes afterwards stores no display rows.
      const later = newSubmissionKey(new Date());
      await m.c.query(
        `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta)
         values ($1, $2, $3, $4, $5, $6, 0, 'complete', '{}', '{}', '{}')`,
        [later.id, later.receivedAt, m.orgA, m.live, m.liveV[1], Buffer.alloc(32)],
      );
      expect((await m.c.query('select legacy_fields from submissions where id = $1', [later.id])).rows).toEqual([{ legacy_fields: null }]);
      expect((await m.c.query<{ n: number }>('select count(*)::int as n from submissions where legacy_fields is not null')).rows[0]!.n).toBe(5);
      // The column holds a list of rows or nothing: a value of another shape is refused by its check.
      expect(pgCode(await failure(m.c.query(`update submissions set legacy_fields = '{"key":"n"}' where id = $1 and received_at = $2`, [later.id, later.receivedAt])))).toBe('23514');
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

  it('files the responses of a form that was never published under a retired legacy version instead of refusing or dropping them', async () => {
    const m = await prototypeAt20();
    try {
      // The prototype's signed-in preview stored a response for any form of the org, published or not. Four shapes of
      // such a form, plus one that has no response (and so needs no stand-in).
      const owner = randomUUID();
      const bare = async (org: string, title: string, draft: object | null, draftRev = 4) => {
        const id = randomUUID();
        await m.c.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [id, org, randomUUID(), owner, title]);
        if (draft) {
          await m.c.query(`insert into form_drafts (form_id, org_id, draft, draft_rev, schema_version, size_bytes, updated_by) values ($1, $2, $3, $4, 2, 10, $5)`, [id, org, JSON.stringify(draft), draftRev, owner]);
        }
        return id;
      };
      const v2Draft = { schemaVersion: 2, title: 'Draft', pages: [{ id: 'page_1', children: ['blk_n'] }], blocks: { blk_n: { id: 'blk_n', key: 'n', type: 'number' } } };
      const withDraft = await bare(m.orgA, 'Previewed with a draft', v2Draft);
      const noDraft = await bare(m.orgA, 'Previewed without a draft', null);
      const oldShape = await bare(m.orgA, 'Previewed with an old-shaped draft', { fields: [{ id: 'x' }] });
      const otherOrg = await bare(m.orgB, 'Previewed in another org', null);
      const noRows = await bare(m.orgA, 'Never previewed', v2Draft);
      // Their display rows come with them too: rows, none (the column's own default), and a value written by hand that is
      // not a list, which is kept as the one element of one instead of failing the migration or being dropped.
      const rowsOf = (n: number) => [{ key: 'n', label: `Preview question ${n}`, value: `Preview answer ${n}` }];
      const received = [
        { n: 10, org: m.orgA, form: withDraft, at: '2026-10-20T10:00:00Z', fields: rowsOf(10), kept: rowsOf(10) },
        { n: 11, org: m.orgA, form: withDraft, at: '2026-10-21T10:00:00Z', fields: [], kept: [] },
        { n: 12, org: m.orgA, form: noDraft, at: '2026-10-22T10:00:00Z', fields: rowsOf(12), kept: rowsOf(12) },
        { n: 13, org: m.orgA, form: oldShape, at: '2026-10-23T10:00:00Z', fields: rowsOf(13), kept: rowsOf(13) },
        { n: 14, org: m.orgB, form: otherOrg, at: '2026-10-24T10:00:00Z', fields: { hand: 'written' }, kept: [{ hand: 'written' }] },
      ];
      for (const r of received) {
        await m.c.query(`insert into form_submissions (id, org_id, form_id, answers, fields, submitted_at) values ($1, $2, $3, $4, $5, $6)`, [
          randomUUID(),
          r.org,
          r.form,
          JSON.stringify({ n: { type: 'number', value: r.n } }),
          JSON.stringify(r.fields),
          r.at,
        ]);
      }
      const versionsBefore = (await m.c.query<{ n: number }>('select count(*)::int as n from form_versions')).rows[0]!.n;
      const countsBefore = await m.counters();
      const notices: string[] = [];
      m.c.on('notice', (n) => notices.push(n.message ?? ''));

      // Not refused: the migration applies, and says how many responses it filed this way.
      expect((await migrate(m.c, m.files.filter((x) => x.version <= 21))).applied).toEqual(['0021_submissions']);
      expect(notices.filter((n) => n.startsWith('0021:'))).toEqual(['0021: 5 prototype response(s) of 4 form(s) that were never published are filed under a legacy version (number 0)']);
      // Nothing was dropped: the five responses are all in submissions, next to the five of the fixture.
      expect((await m.c.query<{ n: number }>('select count(*)::int as n from submissions')).rows[0]!.n).toBe(10);

      // One legacy version for each of the four forms with responses; none for a form that has none, or that has versions.
      const legacy = (
        await m.c.query<{
          id: string;
          org_id: string;
          form_id: string;
          number: number;
          schema_version: number;
          published_by: string;
          definition: Record<string, unknown>;
          compiled: unknown;
          content_hash: string;
          label: string;
          engine: string;
          draft_rev: number | null;
          media: unknown;
          created_ok: boolean;
          hash_ok: boolean;
        }>(
          `select v.id, v.org_id, v.form_id, v.number, v.schema_version, v.published_by, v.definition, v.compiled, v.content_hash, v.label, v.engine, v.draft_rev, v.media,
             v.published_at = f.created_at as created_ok, encode(sha256(convert_to(v.definition::text, 'UTF8')), 'hex') = v.content_hash as hash_ok
           from form_versions v join forms f on f.org_id = v.org_id and f.id = v.form_id where v.label is not null`,
        )
      ).rows;
      expect(legacy.map((v) => v.form_id).sort()).toEqual([withDraft, noDraft, oldShape, otherOrg].sort());
      expect((await m.c.query<{ n: number }>('select count(*)::int as n from form_versions')).rows[0]!.n).toBe(versionsBefore + 4);
      expect((await m.c.query(`select 1 from form_versions where form_id = $1`, [noRows])).rowCount).toBe(0);
      const legacyOf = (formId: string) => legacy.find((v) => v.form_id === formId)!;
      for (const v of legacy) {
        // Number 0: the first real publish is max(number) + 1 = 1. Never compiled, never named for a draft revision (a
        // legacy version holding the draft's revision would make that publish return it), owned by the form's owner.
        expect(v, v.form_id).toMatchObject({
          number: 0,
          label: 'legacy (prototype preview)',
          engine: 'legacy@0',
          compiled: {},
          draft_rev: null,
          media: null,
          published_by: owner,
          created_ok: true,
          hash_ok: true,
        });
      }
      // The definition: a usable draft is copied as it is; anything else becomes an empty one that names the form.
      expect(legacyOf(withDraft)).toMatchObject({ schema_version: 2, definition: v2Draft });
      for (const [formId, title] of [[noDraft, 'Previewed without a draft'], [oldShape, 'Previewed with an old-shaped draft'], [otherOrg, 'Previewed in another org']] as const) {
        expect(legacyOf(formId), title).toMatchObject({ schema_version: 2, definition: { schemaVersion: 2, formId, title, pages: [], blocks: {} } });
      }
      expect(legacyOf(otherOrg).org_id).toBe(m.orgB);
      expect(legacyOf(withDraft).org_id).toBe(m.orgA);

      // Never live and never accepting: the forms stay unpublished, and the version state of each says it is retired,
      // with a superseded date no accept-previous-versions window (at most 720 h) can reach.
      expect((await m.c.query('select 1 from forms where id = any ($1) and live_version_id is not null', [[withDraft, noDraft, oldShape, otherOrg]])).rowCount).toBe(0);
      const states = (
        await m.c.query<{ version_id: string; retired_ok: boolean; superseded_at: Date }>(
          `select version_id, retired_at is not null and retired_at <= now() as retired_ok, superseded_at from form_version_state where version_id = any ($1)`,
          [legacy.map((v) => v.id)],
        )
      ).rows;
      expect(states.map((r) => r.version_id).sort()).toEqual(legacy.map((v) => v.id).sort());
      for (const st of states) {
        expect(st.retired_ok).toBe(true);
        expect(st.superseded_at.getTime()).toBe(0);
      }
      // Every version still has exactly one state row (the 0020 invariant).
      expect((await m.c.query(`select 1 from form_versions v where not exists (select 1 from form_version_state s where s.version_id = v.id)`)).rowCount).toBe(0);

      // The responses are filed under their form's legacy version, with its hash, in the order they were received.
      const filed = (
        await m.c.query<{ n: number; form_id: string; form_version_id: string; hash: string; legacy_fields: unknown }>(
          `select (answers #>> '{n,value}')::int as n, form_id, form_version_id, encode(definition_hash, 'hex') as hash, legacy_fields from submissions where (answers #>> '{n,value}')::int >= 10 order by seq`,
        )
      ).rows;
      expect(filed.map((r) => r.n)).toEqual([10, 11, 12, 13, 14]);
      for (const r of filed) {
        const v = legacyOf(r.form_id);
        expect(r.form_version_id, `row ${r.n}`).toBe(v.id);
        expect(r.hash, `row ${r.n}`).toBe(v.content_hash);
        // Their display rows survived the move with the answers.
        expect(r.legacy_fields, `row ${r.n}`).toEqual(received.find((x) => x.n === r.n)!.kept);
      }
      // The forms' counters are what they were: the copy counts nothing again.
      expect(await m.counters()).toEqual(countsBefore);

      // The legacy version is a version like any other for the rules about versions: immutable...
      expect(pgCode(await failure(m.c.query(`update form_versions set label = 'x' where id = $1`, [legacyOf(withDraft).id])))).toBe('55000');
      // ...and the form's first real publish is version 1, which a unique (org_id, form_id, number) does not refuse.
      const next = (await m.c.query<{ n: number }>('select coalesce(max(number), 0) + 1 as n from form_versions where form_id = $1', [withDraft])).rows[0]!.n;
      expect(next).toBe(1);
      const firstReal = randomUUID();
      await m.c.query(
        `insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash, draft_rev) values ($1, $2, $3, $4, 2, $5, '{}', '{}', $6, 4)`,
        [firstReal, m.orgA, withDraft, next, owner, 'ab'.repeat(32)],
      );
      await m.c.query('update forms set live_version_id = $1 where id = $2', [firstReal, withDraft]);
      // Its state row is live (the trigger of 0020 made it, not retired), and the legacy version's is untouched.
      expect((await m.c.query(`select 1 from form_version_state where version_id = $1 and retired_at is null and superseded_at is null`, [firstReal])).rowCount).toBe(1);
      expect((await m.c.query(`select 1 from form_version_state where version_id = $1 and retired_at is not null`, [legacyOf(withDraft).id])).rowCount).toBe(1);
    } finally {
      await m.c.end();
    }
  });
});

describe('migration 0022 on a database that holds responses and settings', () => {
  /** A database migrated to 0021 and holding an org with its settings row, a form, a member and responses of two statuses. */
  async function at21() {
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
    expect((await migrate(c, files.filter((m) => m.version <= 21))).version).toBe(21);

    const org = randomUUID();
    const user = randomUUID();
    const form = randomUUID();
    const version = randomUUID();
    await c.query(`insert into orgs (id, slug, name) values ($1, 'reviews-22', 'Reviews 22')`, [org]);
    await c.query(`insert into org_settings (org_id, invite_days) values ($1, 14)`, [org]);
    await c.query(`insert into users (id, email, email_norm, password_hash) values ($1, 'o@reviews22.test', 'o@reviews22.test', 'x')`, [user]);
    await c.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [org, user]);
    await c.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [form, org, randomUUID(), user, 'Reviewed later']);
    await c.query(
      `insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash) values ($1, $2, $3, 1, 2, $4, '{}', '{}', $5)`,
      [version, org, form, user, 'ab'.repeat(32)],
    );
    const insert = async (status: string) => {
      const s = newSubmissionKey(new Date());
      await c.query(
        `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta)
         values ($1, $2, $3, $4, $5, $6, 0, $7, '{}', '{}', '{}')`,
        [s.id, s.receivedAt, org, form, version, Buffer.alloc(32), status],
      );
      return s.id;
    };
    const ids = [await insert('complete'), await insert('trashed')];
    return { c, files, org, user, form, version, ids, insert };
  }

  it('applies on top of 0021 as the one new migration, leaves every row as it was, and widens the status check by exactly two values', async () => {
    const m = await at21();
    try {
      // Before: the two values are refused, which is what makes the new migration necessary.
      expect(pgCode(await failure(m.insert('pending_review')))).toBe('23514');
      const before = (await m.c.query('select id, status, answers, seq from submissions order by seq')).rows;
      expect(before).toHaveLength(2);

      const result = await migrate(m.c, m.files.filter((x) => x.version <= 22));
      expect(result).toEqual({ applied: ['0022_submission_reviews'], version: 22 });

      expect((await m.c.query('select id, status, answers, seq from submissions order by seq')).rows).toEqual(before);
      const ok = [await m.insert('pending_review'), await m.insert('rejected'), await m.insert('complete')];
      expect((await m.c.query('select status from submissions where id = any ($1) order by seq', [ok])).rows.map((r) => r.status)).toEqual(['pending_review', 'rejected', 'complete']);
      expect(pgCode(await failure(m.insert('approved')))).toBe('23514');
    } finally {
      await m.c.end();
    }
  });

  it('gives an org that already had settings review_checkers_mfa on, with its other settings untouched, and a new row the same', async () => {
    const m = await at21();
    try {
      await migrate(m.c, m.files.filter((x) => x.version <= 22));
      expect((await m.c.query('select invite_days, review_checkers_mfa from org_settings where org_id = $1', [m.org])).rows).toEqual([{ invite_days: 14, review_checkers_mfa: true }]);
      const other = randomUUID();
      await m.c.query(`insert into orgs (id, slug, name) values ($1, 'reviews-22-b', 'Reviews 22 B')`, [other]);
      await m.c.query('insert into org_settings (org_id) values ($1)', [other]);
      expect((await m.c.query('select review_checkers_mfa from org_settings where org_id = $1', [other])).rows).toEqual([{ review_checkers_mfa: true }]);
    } finally {
      await m.c.end();
    }
  });

  it('makes the review tables empty, with their partitions in schema parts and RLS forced, and a response can then be reviewed and deleted', async () => {
    const m = await at21();
    try {
      await migrate(m.c, m.files.filter((x) => x.version <= 22));
      for (const table of ['review_groups', 'review_group_members', 'form_review_settings', 'submission_reviews', 'review_decisions']) {
        expect((await m.c.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n, table).toBe(0);
      }
      for (const table of ['submission_reviews', 'review_decisions']) {
        const partitions = await partitionsOf(m.c, table);
        expect(partitions, table).toHaveLength(4);
        for (const p of partitions) expect(p, p.name).toMatchObject({ forced: true, owner: 'fr_migrator', grantees: ['fr_migrator'] });
        expect(partitions.every((p) => p.name.startsWith(`parts.${table}_`)), table).toBe(true);
      }
      expect(await rlsViolations(m.c)).toEqual([]);

      // A response that existed before the migration can be put under review, and its deletion takes the review with it.
      const group = randomUUID();
      const submission = (await m.c.query<{ id: string; received_at: Date }>('select id, received_at from submissions where id = $1', [m.ids[0]])).rows[0]!;
      await m.c.query(`insert into review_groups (id, org_id, name, created_by) values ($1, $2, 'Checkers', $3)`, [group, m.org, m.user]);
      await m.c.query(
        `insert into submission_reviews (org_id, form_id, submission_id, submission_received_at, unit_id, required, review_order, group_id, visibility, answers_hash)
         values ($1, $2, $3, $4, 'u1', true, 1, $5, 'own_unit', $6)`,
        [m.org, m.form, submission.id, submission.received_at, group, Buffer.alloc(32)],
      );
      await m.c.query(
        `insert into review_decisions (id, org_id, form_id, submission_id, submission_received_at, unit_id, round, decision, decided_by, answers_hash, form_version_id, idempotency_key)
         values ($1, $2, $3, $4, $5, 'u1', 1, 'approve', $6, $7, $8, 'k1')`,
        [randomUUID(), m.org, m.form, submission.id, submission.received_at, m.user, Buffer.alloc(32), m.version],
      );
      await m.c.query('delete from submissions where id = $1 and received_at = $2', [submission.id, submission.received_at]);
      expect((await m.c.query<{ n: number }>('select (select count(*) from submission_reviews)::int + (select count(*) from review_decisions)::int as n')).rows[0]!.n).toBe(0);
    } finally {
      await m.c.end();
    }
  });
});

describe('migration 0023 on a database that holds responses (WP-1.16, WP-1.17, WP-1.18)', () => {
  const EFFECT_TABLES = ['secrets', 'email_senders', 'notifications', 'email_messages', 'webhooks', 'webhook_deliveries', 'exports', 'disclosures'];

  /** A database migrated to 0022 with one org, form, version and response in it. */
  async function at22() {
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
    expect((await migrate(c, files.filter((m) => m.version <= 22))).version).toBe(22);
    const org = randomUUID();
    const user = randomUUID();
    const form = randomUUID();
    const version = randomUUID();
    await c.query(`insert into orgs (id, slug, name) values ($1, 'effects', 'Effects')`, [org]);
    await c.query(`insert into users (id, email, email_norm, password_hash) values ($1, 'o@effects.test', 'o@effects.test', 'x')`, [user]);
    await c.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [form, org, randomUUID(), user, 'Contact']);
    await c.query(
      `insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash) values ($1, $2, $3, 1, 2, $4, '{}', '{}', $5)`,
      [version, org, form, user, 'ab'.repeat(32)],
    );
    const key = newSubmissionKey(new Date());
    await c.query(
      `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta)
       values ($1, $2, $3, $4, $5, $6, 0, 'complete', '{}', '{}', '{}')`,
      [key.id, key.receivedAt, org, form, version, Buffer.alloc(32)],
    );
    return { c, files, org, user, form, submission: key };
  }

  it('is the file after 0022, applies on top of it, and leaves the data that was there alone', async () => {
    const m = await at22();
    try {
      expect(m.files.find((f) => f.version === 23)?.name).toBe('notify_webhooks_exports');
      expect(m.files.find((f) => f.version === 22)).toBeDefined();
      const result = await migrate(m.c, m.files.filter((f) => f.version <= 23));
      expect(result).toEqual({ applied: ['0023_notify_webhooks_exports'], version: 23 });
      for (const table of EFFECT_TABLES) expect((await m.c.query('select to_regclass($1)::text as t', [`public.${table}`])).rows[0], table).toEqual({ t: table });
      // What 0021 and the earlier migrations hold is as it was.
      expect((await m.c.query('select count(*)::int as n from submissions')).rows[0]).toEqual({ n: 1 });
      expect((await m.c.query('select count(*)::int as n from forms')).rows[0]).toEqual({ n: 1 });
      // Every table forces RLS and has its policies, the definers are pinned and not public: the meta-checks stay quiet.
      expect(await rlsViolations(m.c)).toEqual([]);
    } finally {
      await m.c.end();
    }
  });

  it('puts the two logs in monthly partitions in schema parts: forced RLS, owned by the migrator, nobody else granted', async () => {
    const m = await at22();
    try {
      await migrate(m.c, m.files.filter((f) => f.version <= 23));
      for (const table of ['email_messages', 'webhook_deliveries']) {
        const partitions = await partitionsOf(m.c, table);
        // The current month and three more (create_partitions), none of them the default.
        expect(partitions, table).toHaveLength(4);
        for (const p of partitions) {
          expect(p, p.name).toMatchObject({ name: expect.stringMatching(new RegExp(`^parts\\.${table}_\\d{4}_\\d{2}$`)), forced: true, owner: 'fr_migrator', grantees: ['fr_migrator'] });
        }
      }
      // The same two tables are range-partitioned on created_at, and no other new table is partitioned.
      const { rows } = await m.c.query<{ table: string; key: string }>(
        `select c.relname as table, pg_get_partkeydef(c.oid) as key from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'p' and c.relname = any($1) order by 1`,
        [EFFECT_TABLES],
      );
      expect(rows).toEqual([
        { table: 'email_messages', key: 'RANGE (created_at)' },
        { table: 'webhook_deliveries', key: 'RANGE (created_at)' },
      ]);
    } finally {
      await m.c.end();
    }
  });

  it('keeps resolve_job_org, its grant and its owner, and adds the three resource types', async () => {
    const m = await at22();
    try {
      const before = (await m.c.query<{ acl: string; owner: string }>(`select p.proacl::text as acl, pg_get_userbyid(p.proowner) as owner from pg_proc p where p.proname = 'resolve_job_org'`)).rows[0]!;
      await migrate(m.c, m.files.filter((f) => f.version <= 23));
      const after = (await m.c.query<{ acl: string; owner: string; secdef: boolean; config: string[] }>(
        `select p.proacl::text as acl, pg_get_userbyid(p.proowner) as owner, p.prosecdef as secdef, p.proconfig as config from pg_proc p where p.proname = 'resolve_job_org'`,
      )).rows[0]!;
      expect(after).toMatchObject({ acl: before.acl, owner: before.owner, secdef: true, config: ['search_path=pg_catalog, public'] });
      expect((await m.c.query('select resolve_job_org($1, $2) as org', ['form', m.form])).rows[0]).toEqual({ org: m.org });
      for (const type of ['email_message', 'webhook_delivery', 'export']) expect((await m.c.query('select resolve_job_org($1, $2) as org', [type, randomUUID()])).rows[0], type).toEqual({ org: null });
    } finally {
      await m.c.end();
    }
  });
});
