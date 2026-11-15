import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  orgSettings,
  partitionsOf,
  REVIEW_DECISIONS,
  REVIEW_REASON_CODES,
  REVIEW_STATES,
  REVIEW_VISIBILITIES,
  rlsViolations,
  SUBMISSION_STATUSES,
  withTenant,
  type TenantCtx,
  type Tx,
} from '../src/index.ts';
import {
  failure,
  HASH,
  insertSubmission,
  insertSubmissionSql,
  newSubmission,
  pgCode,
  seedTwoOrgs,
  setupTestDb,
  type OrgSeed,
  type Seed,
  type SubmissionSeed,
  type TestDb,
} from './harness.ts';

/**
 * Section-level maker-checker review, the tables (WP-2.33, migration 0022): who may write them, who may read them, that a
 * decision can never be changed through fr_app, and that deleting a submission deletes its review. The cross-org isolation
 * of every table, for every actor kind, is the generated suite in rls.int.test.ts; the functions that open and decide a
 * review (and their four-eyes rule) are migration 0024's.
 */

let t: TestDb;
let seed: Seed;

beforeAll(async () => {
  t = await setupTestDb();
  seed = await seedTwoOrgs(t.owner);
});
afterAll(() => t?.close());

type Ctx = Omit<TenantCtx, 'requestId' | 'orgId'>;
const as = <T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>, orgId: string = seed.b.orgId) => withTenant(t.app.db, { ...ctx, orgId, requestId: 'reviews-test' }, fn);
const messageOf = (err: unknown) => String((err as { cause?: { message?: string } }).cause?.message ?? err);

const user = (userId: string, perms: string[]): Ctx => ({ actor: 'user', userId, perms });
/** A member of org B with every permission that touches these tables: the table's own rules, not a missing permission, must be what stops a write. */
const everything = (): Ctx =>
  user(seed.b.ownerId, ['forms.read', 'forms.edit', 'ops.manage', 'members.manage', 'org.settings', 'submissions.read', 'submissions.edit', 'submissions.delete', 'submissions.review']);
const system: Ctx = { actor: 'system' };
const respondent: Ctx = { actor: 'respondent' };

const TABLES = ['review_groups', 'review_group_members', 'form_review_settings', 'submission_reviews', 'review_decisions'] as const;

/** What `seedReviewRows` made for org B: its group and the response it hangs on. */
async function seededOf(org: OrgSeed) {
  const group = (await t.owner.query<{ id: string }>('select id from review_groups where org_id = $1', [org.orgId])).rows[0]!.id;
  const submission = (await t.owner.query<{ submission_id: string; submission_received_at: Date }>(
    `select distinct submission_id, submission_received_at from submission_reviews where org_id = $1`,
    [org.orgId],
  )).rows[0]!;
  const decision = (await t.owner.query<{ id: string }>('select id from review_decisions where org_id = $1', [org.orgId])).rows[0]!.id;
  return { group, submissionId: submission.submission_id, receivedAt: submission.submission_received_at, decision };
}

/** A response of org B's first form with an open review of the given units, as the owner (the definers of 0024 will write these in real life). */
async function reviewedSubmission(units: readonly string[] = ['u1', 'u2'], over: Partial<SubmissionSeed> = {}) {
  const sub = await insertSubmission(t.owner, newSubmission(seed.b, 0, { status: 'pending_review', ...over }));
  const { group } = await seededOf(seed.b);
  for (const [i, unit] of units.entries()) {
    await t.owner.query(
      `insert into submission_reviews (org_id, form_id, submission_id, submission_received_at, unit_id, required, review_order, group_id, visibility, answers_hash)
       values ($1, $2, $3, $4, $5, true, $6, $7, 'own_unit', $8)`,
      [seed.b.orgId, seed.b.formIds[0], sub.id, sub.receivedAt, unit, i + 1, group, HASH],
    );
  }
  return { sub, group };
}

async function decide(sub: Pick<SubmissionSeed, 'id' | 'receivedAt'>, unit: string, over: Record<string, unknown> = {}) {
  const row = {
    id: randomUUID(),
    unit,
    round: 1,
    decision: 'approve',
    reason: null as string | null,
    key: `k-${randomUUID()}`,
    version: seed.b.versionIds[0],
    ...over,
  };
  await t.owner.query(
    `insert into review_decisions (id, org_id, form_id, submission_id, submission_received_at, unit_id, round, decision, reason_code, decided_by, answers_hash, form_version_id, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [row.id, seed.b.orgId, seed.b.formIds[0], sub.id, sub.receivedAt, row.unit, row.round, row.decision, row.reason, seed.b.editorId, HASH, row.version, row.key],
  );
  return row;
}

const countOf = async (table: string, where: SQL = sql`true`): Promise<number> =>
  (await as(system, async (tx) => (await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where ${where}`)).rows[0]!.n));

describe('seeded rows', () => {
  it('give every table rows in both orgs, so the isolation suite has something to hide', async () => {
    for (const table of TABLES) {
      const { rows } = await t.owner.query<{ org_id: string }>(`select distinct org_id from ${table}`);
      expect(rows.map((r) => r.org_id).sort(), table).toEqual([seed.a.orgId, seed.b.orgId].sort());
    }
  });
});

describe('fr_app can read the review tables and write neither', () => {
  const some = (table: string, seeded: Awaited<ReturnType<typeof seededOf>>): SQL => {
    const { group, submissionId, receivedAt } = seeded;
    const reviewInsert = sql`insert into submission_reviews (org_id, form_id, submission_id, submission_received_at, unit_id, required, review_order, group_id, visibility, answers_hash)
      values (${seed.b.orgId}, ${seed.b.formIds[0]}, ${submissionId}, ${receivedAt.toISOString()}::timestamptz, 'u9', true, 9, ${group}, 'own_unit', ${HASH})`;
    const decisionInsert = sql`insert into review_decisions (id, org_id, form_id, submission_id, submission_received_at, unit_id, round, decision, decided_by, answers_hash, form_version_id, idempotency_key)
      values (${randomUUID()}, ${seed.b.orgId}, ${seed.b.formIds[0]}, ${submissionId}, ${receivedAt.toISOString()}::timestamptz, 'u1', 2, 'approve', ${seed.b.editorId}, ${HASH}, ${seed.b.versionIds[0]}, ${`direct-${randomUUID()}`})`;
    return table === 'submission_reviews' ? reviewInsert : decisionInsert;
  };

  it.each(['submission_reviews', 'review_decisions'] as const)('refuses INSERT, UPDATE and DELETE on %s with "permission denied", whoever the actor is', async (table) => {
    const seeded = await seededOf(seed.b);
    const before = await countOf(table);
    expect(before).toBeGreaterThan(0);
    const column = table === 'submission_reviews' ? 'state' : 'reason_code';
    const value = table === 'submission_reviews' ? 'closed' : 'other';
    for (const [who, ctx] of [['a member with every permission', everything()], ['a system job', system], ['a respondent', respondent]] as const) {
      for (const [verb, statement] of [
        ['INSERT', some(table, seeded)],
        ['UPDATE', sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${value}`],
        ['DELETE', sql`delete from ${sql.identifier(table)}`],
      ] as const) {
        const err = await failure(as(ctx, (tx) => tx.execute(statement)));
        expect(pgCode(err), `${who}: ${verb}`).toBe('42501');
        expect(messageOf(err), `${who}: ${verb}`).toMatch(/permission denied for table/);
      }
    }
    expect(await countOf(table)).toBe(before);
    expect((await t.owner.query(`select 1 from ${table} where ${column} = $1`, [value])).rowCount).toBe(0);
  });

  it('reads them with submissions.review, with submissions.read, or as a system job, and not with the other permissions or as a respondent', async () => {
    for (const table of ['submission_reviews', 'review_decisions']) {
      const seen = (ctx: Ctx) => as(ctx, async (tx) => (await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)}`)).rows[0]!.n);
      expect(await seen(user(seed.b.editorId, ['forms.read', 'submissions.review'])), table).toBeGreaterThan(0);
      expect(await seen(user(seed.b.editorId, ['forms.read', 'submissions.read'])), table).toBeGreaterThan(0);
      expect(await seen(system), table).toBeGreaterThan(0);
      expect(await seen(user(seed.b.editorId, ['forms.read', 'forms.edit', 'ops.manage', 'members.manage', 'submissions.edit', 'submissions.delete'])), table).toBe(0);
      expect(await seen({ actor: 'api_key', perms: ['forms.read'] }), table).toBe(0);
      expect(await seen(respondent), table).toBe(0);
      // Only the org's own rows: the permissions are granted in org B, and org A's rows stay out of reach.
      expect(await as(user(seed.b.editorId, ['submissions.review']), async (tx) => (await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where org_id = ${seed.a.orgId}`)).rows[0]!.n), table).toBe(0);
    }
  });

  it('names its data-access policy like submissions does, restrictive and for SELECT, so a permissive one cannot stand in for it', async () => {
    const { rows } = await t.owner.query<{ table: string; policy: string; permissive: boolean; cmd: string }>(
      `select polrelid::regclass::text as table, polname as policy, polpermissive as permissive, polcmd as cmd
       from pg_policy where polrelid in ('public.submission_reviews'::regclass, 'public.review_decisions'::regclass) and polname like '%data_access'
       order by 1`,
    );
    expect(rows).toEqual([
      { table: 'review_decisions', policy: 'review_decisions_data_access', permissive: false, cmd: 'r' },
      { table: 'submission_reviews', policy: 'submission_reviews_data_access', permissive: false, cmd: 'r' },
    ]);
  });
});

describe('review groups and their members', () => {
  it('lets members.manage (and a system job) add a group, rename it and archive it, and nobody delete it', async () => {
    const id = randomUUID();
    const manager = user(seed.b.ownerId, ['forms.read', 'members.manage']);
    await as(manager, (tx) => tx.execute(sql`insert into review_groups (id, org_id, name, created_by) values (${id}, ${seed.b.orgId}, 'Finance', ${seed.b.ownerId})`));
    expect(await as(manager, async (tx) => (await tx.execute(sql`update review_groups set name = 'Finance team' where id = ${id}`)).rowCount)).toBe(1);
    expect(await as(system, async (tx) => (await tx.execute(sql`update review_groups set archived_at = now() where id = ${id}`)).rowCount)).toBe(1);
    expect((await t.owner.query<{ name: string; archived: boolean }>('select name, archived_at is not null as archived from review_groups where id = $1', [id])).rows).toEqual([
      { name: 'Finance team', archived: true },
    ]);
    // No delete, and no change to the columns that name who made it and where it belongs.
    for (const ctx of [manager, system, everything()]) {
      expect(pgCode(await failure(as(ctx, (tx) => tx.execute(sql`delete from review_groups where id = ${id}`))))).toBe('42501');
      expect(pgCode(await failure(as(ctx, (tx) => tx.execute(sql`update review_groups set created_by = ${seed.b.editorId} where id = ${id}`))))).toBe('42501');
    }
    await as(system, (tx) => tx.execute(sql`insert into review_groups (id, org_id, name, created_by) values (${randomUUID()}, ${seed.b.orgId}, 'Made by a job', ${seed.b.ownerId})`));
  });

  it('refuses a group to a member without members.manage (a viewer, an editor), whatever else they may do', async () => {
    const attempt = (ctx: Ctx) =>
      as(ctx, (tx) => tx.execute(sql`insert into review_groups (id, org_id, name, created_by) values (${randomUUID()}, ${seed.b.orgId}, 'Sneaky', ${seed.b.viewerId})`));
    for (const ctx of [
      user(seed.b.viewerId, ['forms.read']),
      user(seed.b.editorId, ['forms.read', 'forms.edit', 'ops.manage', 'submissions.read', 'submissions.review']),
      { actor: 'api_key', perms: ['forms.read', 'members.read'] } satisfies Ctx,
      respondent,
    ]) {
      const err = await failure(attempt(ctx));
      expect(pgCode(err), ctx.actor).toBe('42501');
      expect(messageOf(err), ctx.actor).toMatch(/violates row-level security policy "review_groups_manage_insert" for table "review_groups"/);
    }
    // Renaming or archiving changes no row either: the restrictive update policy hides them from a member who may not manage.
    const { group } = await seededOf(seed.b);
    const editor = user(seed.b.editorId, ['forms.read', 'forms.edit', 'ops.manage']);
    expect(await as(editor, async (tx) => (await tx.execute(sql`update review_groups set name = 'Renamed' where id = ${group}`)).rowCount)).toBe(0);
    expect((await t.owner.query('select name from review_groups where id = $1', [group])).rows).toEqual([{ name: 'Checkers' }]);
  });

  it('refuses a group member to a viewer-permissions context, and takes one from members.manage', async () => {
    const { group } = await seededOf(seed.b);
    const add = (ctx: Ctx, who: string) =>
      as(ctx, (tx) =>
        tx.execute(sql`insert into review_group_members (org_id, group_id, user_id, added_by) values (${seed.b.orgId}, ${group}, ${who}, ${seed.b.ownerId})`),
      );
    const viewer = user(seed.b.viewerId, ['forms.read', 'submissions.read']);
    const err = await failure(add(viewer, seed.b.viewerId));
    expect(pgCode(err)).toBe('42501');
    expect(messageOf(err)).toMatch(/violates row-level security policy "review_group_members_manage_insert" for table "review_group_members"/);
    expect(pgCode(await failure(add(respondent, seed.b.viewerId)))).toBe('42501');
    expect((await t.owner.query('select 1 from review_group_members where group_id = $1 and user_id = $2', [group, seed.b.viewerId])).rowCount).toBe(0);

    await add(user(seed.b.ownerId, ['forms.read', 'members.manage']), seed.b.viewerId);
    expect((await t.owner.query('select 1 from review_group_members where group_id = $1 and user_id = $2', [group, seed.b.viewerId])).rowCount).toBe(1);

    // Removing a member needs the same permission: a viewer's DELETE finds nothing to delete, the manager's removes the row. A row is never edited.
    expect(await as(viewer, async (tx) => (await tx.execute(sql`delete from review_group_members where user_id = ${seed.b.viewerId}`)).rowCount)).toBe(0);
    expect(pgCode(await failure(as(everything(), (tx) => tx.execute(sql`update review_group_members set added_by = user_id`))))).toBe('42501');
    expect(await as(everything(), async (tx) => (await tx.execute(sql`delete from review_group_members where user_id = ${seed.b.viewerId}`)).rowCount)).toBe(1);
  });

  it('keeps a checker a member of the org: the key to memberships refuses a stranger, and removing the member removes them from every group', async () => {
    const { group } = await seededOf(seed.b);
    const stranger = randomUUID();
    await t.owner.query(`insert into users (id, email, email_norm, password_hash) values ($1, $2, $2, 'x')`, [stranger, `stranger-${stranger}@x.test`]);
    const insert = (who: string, org = seed.b.orgId) =>
      t.owner.query('insert into review_group_members (org_id, group_id, user_id, added_by) values ($1, $2, $3, $4)', [org, group, who, seed.b.ownerId]);
    // A user who is not a member of the org, and a member of org A named under org B's group.
    expect(pgCode(await failure(insert(stranger)))).toBe('23503');
    expect(pgCode(await failure(insert(seed.a.editorId)))).toBe('23503');
    // A group of another org cannot be named under this org either.
    expect(pgCode(await failure(t.owner.query('insert into review_group_members (org_id, group_id, user_id, added_by) values ($1, $2, $3, $4)', [seed.a.orgId, group, seed.a.editorId, seed.a.ownerId])))).toBe('23503');

    const leaver = randomUUID();
    await t.owner.query(`insert into users (id, email, email_norm, password_hash) values ($1, $2, $2, 'x')`, [leaver, `leaver-${leaver}@x.test`]);
    await t.owner.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'editor')`, [seed.b.orgId, leaver]);
    await insert(leaver);
    expect((await t.owner.query('select 1 from review_group_members where user_id = $1', [leaver])).rowCount).toBe(1);
    await t.owner.query('delete from memberships where org_id = $1 and user_id = $2', [seed.b.orgId, leaver]);
    expect((await t.owner.query('select 1 from review_group_members where user_id = $1', [leaver])).rowCount).toBe(0);
  });

  it('is invisible to a respondent context and visible to the org’s other actors', async () => {
    for (const table of ['review_groups', 'review_group_members']) {
      const seen = (ctx: Ctx) => as(ctx, async (tx) => (await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)}`)).rows[0]!.n);
      expect(await seen(respondent), table).toBe(0);
      expect(await seen(user(seed.b.viewerId, ['forms.read'])), table).toBeGreaterThan(0);
      expect(await seen(system), table).toBeGreaterThan(0);
    }
  });

  it('validates a group’s name, and never lets the same member join a group twice', async () => {
    const { group } = await seededOf(seed.b);
    for (const name of ['', 'x'.repeat(121)]) {
      expect(pgCode(await failure(t.owner.query('insert into review_groups (id, org_id, name, created_by) values ($1, $2, $3, $4)', [randomUUID(), seed.b.orgId, name, seed.b.ownerId]))), name.length.toString()).toBe('23514');
    }
    expect(pgCode(await failure(t.owner.query('insert into review_group_members (org_id, group_id, user_id, added_by) values ($1, $2, $3, $4)', [seed.b.orgId, group, seed.b.editorId, seed.b.ownerId])))).toBe('23505');
  });
});

describe('form_review_settings', () => {
  const settings = JSON.stringify({ distinctCheckers: true, units: [] });

  it('lets ops.manage (and a system job) set a form up and change it, and an editor without ops.manage do neither', async () => {
    const editor = user(seed.b.editorId, ['forms.read', 'forms.edit', 'forms.publish', 'submissions.read']);
    const insert = (ctx: Ctx, formId: string) =>
      as(ctx, (tx) => tx.execute(sql`insert into form_review_settings (form_id, org_id, enabled, settings, updated_by) values (${formId}, ${seed.b.orgId}, true, ${settings}::jsonb, ${seed.b.editorId})`));
    // The second form has no row yet: an editor without ops.manage cannot create it.
    const err = await failure(insert(editor, seed.b.formIds[1]));
    expect(pgCode(err)).toBe('42501');
    expect(messageOf(err)).toMatch(/violates row-level security policy "form_review_settings_ops_insert" for table "form_review_settings"/);
    expect((await t.owner.query('select 1 from form_review_settings where form_id = $1', [seed.b.formIds[1]])).rowCount).toBe(0);
    await insert(user(seed.b.editorId, ['forms.read', 'ops.manage']), seed.b.formIds[1]);

    // The first form has one: an editor without ops.manage changes nothing (the update policy hides the row), the one with it does.
    const before = (await t.owner.query<{ rev: number; enabled: boolean }>('select rev, enabled from form_review_settings where form_id = $1', [seed.b.formIds[0]])).rows[0]!;
    expect(before).toEqual({ rev: 1, enabled: true });
    const change = (ctx: Ctx) =>
      as(ctx, async (tx) => (await tx.execute(sql`update form_review_settings set enabled = false, rev = rev + 1, updated_by = ${seed.b.editorId}, updated_at = now() where form_id = ${seed.b.formIds[0]}`)).rowCount);
    expect(await change(editor)).toBe(0);
    expect(await change(respondent)).toBe(0);
    expect((await t.owner.query('select rev, enabled from form_review_settings where form_id = $1', [seed.b.formIds[0]])).rows).toEqual([before]);
    expect(await change(user(seed.b.editorId, ['forms.read', 'ops.manage']))).toBe(1);
    expect(await as(system, async (tx) => (await tx.execute(sql`update form_review_settings set enabled = true, rev = rev + 1 where form_id = ${seed.b.formIds[0]}`)).rowCount)).toBe(1);
    expect((await t.owner.query('select rev, enabled from form_review_settings where form_id = $1', [seed.b.formIds[0]])).rows).toEqual([{ rev: 3, enabled: true }]);
  });

  it('never moves a row to another form or org, never deletes it, and holds a jsonb object', async () => {
    const ops = user(seed.b.editorId, ['forms.read', 'ops.manage']);
    for (const column of ['form_id', 'org_id']) {
      expect(pgCode(await failure(as(ops, (tx) => tx.execute(sql`update form_review_settings set ${sql.identifier(column)} = ${sql.identifier(column)}`)))), column).toBe('42501');
    }
    for (const ctx of [ops, system, everything()]) expect(pgCode(await failure(as(ctx, (tx) => tx.execute(sql`delete from form_review_settings`)))), ctx.actor).toBe('42501');
    expect(pgCode(await failure(t.owner.query(`update form_review_settings set settings = '[]'::jsonb where form_id = $1`, [seed.b.formIds[0]])))).toBe('23514');
    expect(pgCode(await failure(t.owner.query(`update form_review_settings set rev = 0 where form_id = $1`, [seed.b.formIds[0]])))).toBe('23514');
    // A form of another org cannot be set up from this one.
    expect(pgCode(await failure(t.owner.query(`insert into form_review_settings (form_id, org_id) values ($1, $2)`, [seed.a.formIds[1], seed.b.orgId])))).toBe('23503');
  });

  it('is readable by a respondent context (the submit transaction asks whether the form is reviewed) and by nobody of another org', async () => {
    const seen = (ctx: Ctx, orgId?: string) => as(ctx, async (tx) => (await tx.execute<{ enabled: boolean }>(sql`select enabled from form_review_settings where form_id = ${seed.b.formIds[0]}`)).rows, orgId);
    expect(await seen(respondent)).toEqual([{ enabled: true }]);
    expect(await seen(respondent, seed.a.orgId)).toEqual([]);
  });
});

describe('org_settings.review_checkers_mfa', () => {
  it('is on by default, and org.settings turns it off and on again', async () => {
    expect((await t.owner.query<{ on: boolean }>('select review_checkers_mfa as on from org_settings where org_id = $1', [seed.b.orgId])).rows).toEqual([{ on: true }]);
    const admin = user(seed.b.ownerId, ['forms.read', 'org.settings']);
    const set = (ctx: Ctx, value: boolean) => as(ctx, async (tx) => (await tx.execute(sql`update org_settings set review_checkers_mfa = ${value}, updated_by = ${seed.b.ownerId}, updated_at = now()`)).rowCount);
    expect(await set(admin, false)).toBe(1);
    expect((await t.owner.query('select review_checkers_mfa as on from org_settings where org_id = $1', [seed.b.orgId])).rows).toEqual([{ on: false }]);
    // A member without org.settings cannot weaken the rule back and forth: the policy of 0008 hides the row from the update.
    expect(await set(user(seed.b.editorId, ['forms.read', 'forms.edit']), true)).toBe(0);
    expect(await set(admin, true)).toBe(1);
    expect((await t.owner.query('select review_checkers_mfa as on from org_settings where org_id = $1', [seed.b.orgId])).rows).toEqual([{ on: true }]);
  });

  it('is written by Drizzle’s own INSERT (which names every column) without being named, and defaults to on', async () => {
    const org = randomUUID();
    await t.owner.query(`insert into orgs (id, slug, name) values ($1, $2, 'No settings yet')`, [org, `nosettings-${org.slice(0, 8)}`]);
    const [row] = await as(
      user(randomUUID(), ['org.settings']),
      (tx) => tx.insert(orgSettings).values({ orgId: org }).returning({ mfa: orgSettings.reviewCheckersMfa, invite: orgSettings.inviteDays }),
      org,
    );
    expect(row).toEqual({ mfa: true, invite: 7 });
  });
});

describe('submissions.status', () => {
  const asRespondent = (row: SubmissionSeed) => as(respondent, (tx) => tx.execute(insertSubmissionSql(row)));

  it('takes pending_review and rejected from the submit transaction, and still refuses a status nobody defined', async () => {
    for (const status of ['pending_review', 'rejected']) {
      const row = newSubmission(seed.b, 0, { status });
      await asRespondent(row);
      expect((await t.owner.query('select status from submissions where id = $1', [row.id])).rows).toEqual([{ status }]);
    }
    for (const status of ['approved', 'pending', 'in_review', 'PENDING_REVIEW', '']) {
      const err = await failure(asRespondent(newSubmission(seed.b, 0, { status })));
      expect(pgCode(err), status).toBe('23514');
      expect(messageOf(err), status).toMatch(/violates check constraint "submissions_status_check"/);
    }
  });

  it('is the list the code names: SUBMISSION_STATUSES and the check of every partition say the same eight plus two', async () => {
    const quoted = (def: string) => [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!).sort();
    const { rows } = await t.owner.query<{ relation: string; def: string }>(
      `select conrelid::regclass::text as relation, pg_get_constraintdef(oid) as def from pg_constraint where conname = 'submissions_status_check' order by 1`,
    );
    const partitions = await partitionsOf(t.owner, 'submissions');
    expect(rows.map((r) => r.relation)).toEqual([...new Set(['submissions', ...partitions.map((p) => p.name)])].sort());
    for (const r of rows) expect(quoted(r.def), r.relation).toEqual([...SUBMISSION_STATUSES].sort());
    expect(SUBMISSION_STATUSES).toHaveLength(10);
    expect(SUBMISSION_STATUSES.slice(-2)).toEqual(['pending_review', 'rejected']);
  });
});

describe('deleting a submission deletes its review', () => {
  it('removes its submission_reviews and review_decisions rows when a system job deletes it, through the append-only trigger, and nothing else', async () => {
    const { sub } = await reviewedSubmission();
    await decide(sub, 'u1');
    await decide(sub, 'u2', { decision: 'reject', reason: 'incorrect' });
    const bySub = sql`submission_id = ${sub.id}`;
    expect(await countOf('submission_reviews', bySub)).toBe(2);
    expect(await countOf('review_decisions', bySub)).toBe(2);
    const others = { reviews: await countOf('submission_reviews'), decisions: await countOf('review_decisions') };

    await as(system, (tx) => tx.execute(sql`delete from submissions where id = ${sub.id} and received_at = ${sub.receivedAt.toISOString()}::timestamptz`));

    expect((await t.owner.query('select 1 from submissions where id = $1', [sub.id])).rowCount).toBe(0);
    expect((await t.owner.query('select 1 from submission_reviews where submission_id = $1', [sub.id])).rowCount).toBe(0);
    expect((await t.owner.query('select 1 from review_decisions where submission_id = $1', [sub.id])).rowCount).toBe(0);
    // Other submissions' reviews stay.
    expect(await countOf('submission_reviews')).toBe(others.reviews - 2);
    expect(await countOf('review_decisions')).toBe(others.decisions - 2);
  });

  it('does the same for a member who may delete responses, which is how the trash purge runs', async () => {
    const { sub } = await reviewedSubmission(['u1']);
    await decide(sub, 'u1');
    const purger = user(seed.b.ownerId, ['forms.read', 'submissions.read', 'submissions.delete']);
    expect(await as(purger, async (tx) => (await tx.execute(sql`delete from submissions where id = ${sub.id} and received_at = ${sub.receivedAt.toISOString()}::timestamptz`)).rowCount)).toBe(1);
    expect((await t.owner.query('select 1 from submission_reviews where submission_id = $1', [sub.id])).rowCount).toBe(0);
    expect((await t.owner.query('select 1 from review_decisions where submission_id = $1', [sub.id])).rowCount).toBe(0);
  });

  it('refuses a review or a decision of a response that does not exist', async () => {
    const ghost = newSubmission(seed.b, 0);
    expect(
      pgCode(
        await failure(
          t.owner.query(
            `insert into submission_reviews (org_id, form_id, submission_id, submission_received_at, unit_id, required, review_order, group_id, visibility, answers_hash)
             values ($1, $2, $3, $4, 'u1', true, 1, $5, 'own_unit', $6)`,
            [seed.b.orgId, seed.b.formIds[0], ghost.id, ghost.receivedAt, (await seededOf(seed.b)).group, HASH],
          ),
        ),
      ),
    ).toBe('23503');
    expect(pgCode(await failure(decide(ghost, 'u1')))).toBe('23503');
  });
});

describe('review_decisions are append-only', () => {
  it('refuses UPDATE and DELETE to a role that is not the table’s owner even if its grants were widened, with the trigger’s own message', async () => {
    const { sub } = await reviewedSubmission(['u1']);
    const d = await decide(sub, 'u1');
    // fr_app has no UPDATE or DELETE privilege, so its refusal is "permission denied" before the trigger is reached (the test above). The trigger
    // is the second lock: widen the grants for the length of this test and it must still say no.
    await t.owner.query('grant update, delete on review_decisions to fr_app');
    try {
      for (const statement of [sql`update review_decisions set reason_code = 'other' where id = ${d.id}`, sql`delete from review_decisions where id = ${d.id}`]) {
        const err = await failure(as(system, (tx) => tx.execute(statement)));
        expect(pgCode(err)).toBe('42501');
        expect(messageOf(err)).toMatch(/review_decisions is append-only \((UPDATE|DELETE) refused\)/);
      }
    } finally {
      await t.owner.query('revoke update, delete on review_decisions from fr_app');
    }
    expect((await t.owner.query('select decision, reason_code from review_decisions where id = $1', [d.id])).rows).toEqual([{ decision: 'approve', reason_code: null }]);
    // The owner passes: the definers of 0024, the erasure of a respondent's message (WP-2.18) and the cascade of the submission's key run as the owner.
    expect((await t.owner.query(`update review_decisions set reason_code = 'other' where id = $1`, [d.id])).rowCount).toBe(1);
    expect((await t.owner.query('delete from review_decisions where id = $1', [d.id])).rowCount).toBe(1);
  });
});

describe('what the rows may hold', () => {
  it('keeps the vocabularies of the database and the code the same', async () => {
    const def = async (table: string, column: string) =>
      (await t.owner.query<{ def: string }>(
        `select pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         where c.conrelid = $1::regclass and c.contype = 'c' and a.attname = $2 and pg_get_constraintdef(c.oid) like '%::text%' and c.conname not like '%reject_reason'`,
        [table, column],
      )).rows.map((r) => [...r.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!).sort());
    expect(await def('submission_reviews', 'state')).toEqual([[...REVIEW_STATES].sort()]);
    expect(await def('submission_reviews', 'visibility')).toEqual([[...REVIEW_VISIBILITIES].sort()]);
    expect(await def('review_decisions', 'reason_code')).toEqual([[...REVIEW_REASON_CODES].sort()]);
    expect(await def('review_decisions', 'decision')).toEqual([[...REVIEW_DECISIONS].sort()]);
  });

  it('refuses a state, visibility, order, hash or round the code does not define', async () => {
    const { sub } = await reviewedSubmission(['u1']);
    const { group } = await seededOf(seed.b);
    const unit = (n: string, over: Record<string, unknown>) => {
      const row = { unit: n, state: 'pending', order: 1, visibility: 'own_unit', hash: HASH, round: 1, ...over };
      return t.owner.query(
        `insert into submission_reviews (org_id, form_id, submission_id, submission_received_at, unit_id, state, round, required, review_order, group_id, visibility, answers_hash)
         values ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $11)`,
        [seed.b.orgId, seed.b.formIds[0], sub.id, sub.receivedAt, row.unit, row.state, row.round, row.order, group, row.visibility, row.hash],
      );
    };
    for (const over of [{ state: 'returned' }, { state: 'done' }, { visibility: 'everything' }, { order: 0 }, { round: 0 }, { hash: Buffer.alloc(31) }, { unit: '' }, { unit: 'u'.repeat(65) }]) {
      expect(pgCode(await failure(unit(String(over.unit ?? 'x'), over))), JSON.stringify(over)).toBe('23514');
    }
    // Every state the code names is accepted; the unit is the key, so a unit is never listed twice.
    for (const state of REVIEW_STATES) await unit(`s-${state}`, { state });
    expect(pgCode(await failure(unit('u1', {})))).toBe('23505');
    // The group of another org cannot be asked.
    expect(
      pgCode(
        await failure(
          t.owner.query(
            `insert into submission_reviews (org_id, form_id, submission_id, submission_received_at, unit_id, required, review_order, group_id, visibility, answers_hash)
             values ($1, $2, $3, $4, 'other-org', true, 1, $5, 'own_unit', $6)`,
            [seed.b.orgId, seed.b.formIds[0], sub.id, sub.receivedAt, (await seededOf(seed.a)).group, HASH],
          ),
        ),
      ),
    ).toBe('23503');
  });

  it('refuses a decision without the catalogue’s reason for a reject, another reason, a bad hash, a version of another form, or a repeated key', async () => {
    const { sub } = await reviewedSubmission(['u1', 'u2']);
    for (const reason of REVIEW_REASON_CODES) await decide(sub, 'u1', { decision: 'reject', reason });
    await decide(sub, 'u1', { round: 2 });
    await decide(sub, 'u2', { reason: 'other' });
    expect(pgCode(await failure(decide(sub, 'u1', { decision: 'reject', reason: null })))).toBe('23514');
    expect(pgCode(await failure(decide(sub, 'u1', { decision: 'reject', reason: 'because I said so' })))).toBe('23514');
    expect(pgCode(await failure(decide(sub, 'u1', { decision: 'return' })))).toBe('23514');
    expect(pgCode(await failure(decide(sub, 'u1', { round: 0 })))).toBe('23514');
    // The version must be one of this org's form (the second form's version names another form).
    expect(pgCode(await failure(decide(sub, 'u1', { version: seed.b.versionIds[1] })))).toBe('23503');
    expect(pgCode(await failure(decide(sub, 'u1', { version: seed.a.versionIds[0] })))).toBe('23503');
    const key = `once-${randomUUID()}`;
    await decide(sub, 'u1', { key });
    expect(pgCode(await failure(decide(sub, 'u2', { key })))).toBe('23505');
    // The same key in another org is another key.
    const other = (await t.owner.query<{ id: string; received_at: Date }>('select id, received_at from submissions where org_id = $1 limit 1', [seed.a.orgId])).rows[0]!;
    await t.owner.query(
      `insert into review_decisions (id, org_id, form_id, submission_id, submission_received_at, unit_id, round, decision, decided_by, answers_hash, form_version_id, idempotency_key)
       values ($1, $2, $3, $4, $5, 'u1', 1, 'approve', $6, $7, $8, $9)`,
      [randomUUID(), seed.a.orgId, seed.a.formIds[0], other.id, other.received_at, seed.a.editorId, HASH, seed.a.versionIds[0], key],
    );
    expect(pgCode(await failure(t.owner.query(
      `insert into review_decisions (id, org_id, form_id, submission_id, submission_received_at, unit_id, round, decision, decided_by, answers_hash, form_version_id, idempotency_key)
       values ($1, $2, $3, $4, $5, 'u1', 1, 'approve', $6, $7, $8, $9)`,
      [randomUUID(), seed.b.orgId, seed.b.formIds[0], sub.id, sub.receivedAt, seed.b.editorId, Buffer.alloc(16), seed.b.versionIds[0], 'short-hash'],
    )))).toBe('23514');
  });
});

describe('partitions', () => {
  const PARTITIONED = ['submission_reviews', 'review_decisions'] as const;

  it.each(PARTITIONED)('puts %s in monthly range partitions in schema parts, from the current month to three ahead, with forced RLS, no grants and no default partition', async (table) => {
    const { rows: months } = await t.owner.query<{ name: string }>(
      `select 'parts.${table}_' || to_char(date_trunc('month', now() at time zone 'UTC') + make_interval(months => i), 'YYYY_MM') as name
       from generate_series(0, 3) i order by i`,
    );
    const partitions = await partitionsOf(t.owner, table);
    expect(partitions.map((p) => p.name)).toEqual(months.map((m) => m.name));
    for (const p of partitions) expect(p, p.name).toMatchObject({ forced: true, owner: 'fr_migrator', grantees: ['fr_migrator'] });
    const { rows } = await t.owner.query<{ strategy: string; key: string; defaults: number }>(
      `select p.partstrat as strategy, a.attname as key,
         (select count(*)::int from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = p.partrelid and pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT') as defaults
       from pg_partitioned_table p join pg_attribute a on a.attrelid = p.partrelid and a.attnum = p.partattrs[0]
       where p.partrelid = $1::regclass`,
      [`public.${table}`],
    );
    expect(rows).toEqual([{ strategy: 'r', key: 'submission_received_at', defaults: 0 }]);
  });

  it('is carried on by partitions.maintain: create_partitions() skips what exists, and a later month is made for both tables', async () => {
    for (const table of PARTITIONED) {
      expect((await t.owner.query(`select create_partitions('public.${table}'::regclass, 3) as name`)).rows).toEqual([]);
      const made = (await t.owner.query<{ name: string }>(`select create_partitions('public.${table}'::regclass, 4) as name`)).rows;
      expect(made, table).toHaveLength(1);
      const [partition] = (await partitionsOf(t.owner, table)).filter((p) => p.name === `parts.${made[0]!.name}`);
      expect(partition, table).toMatchObject({ forced: true, owner: 'fr_migrator', grantees: ['fr_migrator'] });
    }
  });

  it('has the append-only trigger and the foreign keys on every partition, the later ones included', async () => {
    const { rows } = await t.owner.query<{ relation: string; triggers: string[]; fks: string[] }>(
      `select c.oid::regclass::text as relation,
         array(select tgname::text from pg_trigger g where g.tgrelid = c.oid and not g.tgisinternal and g.tgname = 'review_decisions_append_only') as triggers,
         array(select conname::text from pg_constraint k where k.conrelid = c.oid and k.contype = 'f' and k.conname like '%submission_fkey' order by 1) as fks
       from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'public.review_decisions'::regclass order by 1`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) expect(r, r.relation).toMatchObject({ triggers: ['review_decisions_append_only'], fks: ['review_decisions_submission_fkey'] });
    const reviews = await t.owner.query<{ fks: string[] }>(
      `select array(select conname::text from pg_constraint k where k.conrelid = c.oid and k.contype = 'f' and k.conname like '%submission_fkey') as fks
       from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'public.submission_reviews'::regclass`,
    );
    for (const r of reviews.rows) expect(r.fks).toEqual(['submission_reviews_submission_fkey']);
  });

  it('denies a direct SELECT, INSERT, UPDATE and DELETE on a parts.* review partition, to a member, a respondent and a system job', async () => {
    for (const table of PARTITIONED) {
      const partition = (await partitionsOf(t.owner, table))[0]!.name;
      for (const [who, ctx] of [['a member', everything()], ['a respondent', respondent], ['a system job', system]] as const) {
        for (const statement of [`select * from ${partition}`, `update ${partition} set round = round`, `delete from ${partition}`, `insert into ${partition} (org_id) values ('${seed.b.orgId}')`]) {
          const err = await failure(as(ctx, (tx) => tx.execute(sql.raw(statement))));
          expect(pgCode(err), `${who}: ${statement}`).toBe('42501');
          expect(messageOf(err), `${who}: ${statement}`).toMatch(/permission denied/);
        }
      }
    }
  });

  it('passes the RLS meta-checks with the new tables: forced RLS, a policy, a tenant policy, and no partition outside parts or granted', async () => {
    expect(await rlsViolations(t.owner)).toEqual([]);
    const { rows } = await t.owner.query<{ table: string; forced: boolean; policy: boolean }>(
      `select c.relname as table, c.relrowsecurity and c.relforcerowsecurity as forced,
         exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = c.relname || '_tenant') as policy
       from pg_class c where c.relname = any ($1) and c.relnamespace = 'public'::regnamespace order by 1`,
      [[...TABLES]],
    );
    expect(rows).toEqual([...TABLES].sort().map((table) => ({ table, forced: true, policy: true })));
  });
});
