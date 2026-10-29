import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountDelete,
  accountExportData,
  audit,
  authUserByEmail,
  chainPending,
  PLATFORM_ORG_KEY,
  userGrievances,
  userNoticeAcks,
  withTenant,
  withUser,
} from '../src/index.ts';
import { failure, pgCode, setupTestDb, type TestDb } from './harness.ts';

let t: TestDb;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(() => t?.close());

const r = (userId: string) => ({ userId, requestId: 'account-test' });

async function user(tag: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${tag}-${id.slice(0, 8)}@account.test`;
  await t.owner.query(`insert into users (id, email, email_norm, name, locale, password_hash, email_verified_at) values ($1, $2, $2, $3, 'en-IN', 'argon2id$x', now())`, [
    id,
    email,
    `Name ${tag}`,
  ]);
  return { id, email };
}

async function org(members: Array<[string, string]>): Promise<string> {
  const id = randomUUID();
  await t.owner.query('insert into orgs (id, slug, name) values ($1, $2, $3)', [id, `org-${id.slice(0, 8)}`, `Org ${id.slice(0, 4)}`]);
  for (const [i, [userId, role]] of members.entries()) {
    await t.owner.query(`insert into memberships (org_id, user_id, role, created_at) values ($1, $2, $3, now() - make_interval(days => $4))`, [id, userId, role, 10 - i]);
  }
  return id;
}

async function form(orgId: string, ownerId: string): Promise<string> {
  const id = randomUUID();
  await t.owner.query('insert into forms (id, org_id, team_id, owner_user_id, title, updated_by) values ($1, $2, $3, $4, $5, $4)', [id, orgId, randomUUID(), ownerId, 'A form']);
  return id;
}

/** Sessions, a linked account, a link token, a notice and a grievance: everything an account carries. */
async function equip(userId: string): Promise<void> {
  await t.owner.query(
    `insert into sessions (id, token_hash, user_id, mfa_level, ip_hash, ua_summary, idle_expires_at, absolute_expires_at)
     values ($1, $2, $3, 'pwd', $4, 'Firefox on Linux', now() + interval '1 hour', now() + interval '1 day')`,
    [randomUUID(), randomBytes(32), userId, randomBytes(32)],
  );
  await t.owner.query(`insert into user_identities (id, user_id, provider, subject) values ($1, $2, 'google', $3)`, [randomUUID(), userId, `sub-${userId}`]);
  await t.owner.query(`insert into auth_tokens (id, token_hash, purpose, user_id, expires_at) values ($1, $2, 'magic_link', $3, now() + interval '15 minutes')`, [
    randomUUID(),
    randomBytes(32),
    userId,
  ]);
  await withUser(t.app.db, r(userId), async (tx) => {
    await tx.insert(userNoticeAcks).values({ id: randomUUID(), userId, noticeVersion: '2026-10-19', noticeHash: randomBytes(32), locale: 'en-IN', context: 'signup' });
    await tx.insert(userGrievances).values({
      id: randomUUID(),
      userId,
      reference: `GRV-${randomRef()}`,
      category: 'information',
      message: 'Please tell me what you hold about me.',
      dueAt: new Date(Date.now() + 86_400_000),
    });
  });
}

const randomRef = () =>
  Array.from(randomBytes(8))
    .map((b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b % 32])
    .join('');

describe('account functions', () => {
  it('run only for the user themselves, outside any org', async () => {
    const me = await user('self');
    const other = await user('other');
    const orgId = await org([[me.id, 'owner']]);
    for (const run of [
      () => withUser(t.app.db, r(other.id), (tx) => accountDelete(tx, me.id, { apply: false })),
      () => withUser(t.app.db, r(other.id), (tx) => accountExportData(tx, me.id)),
      () => withTenant(t.app.db, { orgId, actor: 'user', userId: me.id, perms: [], requestId: 'x' }, (tx) => accountDelete(tx, me.id, { apply: true })),
      () => withTenant(t.app.db, { orgId, actor: 'system', perms: [], requestId: 'x' }, (tx) => accountExportData(tx, me.id)),
      () => t.app.db.transaction((tx) => accountDelete(tx, me.id, { apply: true })),
    ]) {
      expect(pgCode(await failure(run()))).toBe('42501');
    }
    // fr_app cannot reach the helpers behind them directly.
    expect(pgCode(await failure(t.app.db.execute(sql`select * from account_org_plan(${me.id}::uuid)`)))).toBe('42501');
  });

  it('account_export_data lists every membership with the forms owned, and the user’s own platform audit events', async () => {
    const me = await user('export');
    const other = await user('export-other');
    const orgId = await org([
      [me.id, 'editor'],
      [other.id, 'owner'],
    ]);
    await form(orgId, me.id);
    await t.owner.query(`update memberships set status = 'suspended' where org_id = $1 and user_id = $2`, [orgId, me.id]);
    await withUser(t.app.db, r(me.id), (tx) =>
      audit.append(tx, PLATFORM_ORG_KEY, { actorKind: 'user', actorId: me.id, action: 'auth.logout', resourceType: 'session', resourceId: randomUUID(), outcome: 'success', actorUa: 'Firefox' }),
    );
    await withUser(t.app.db, r(other.id), (tx) =>
      audit.append(tx, PLATFORM_ORG_KEY, { actorKind: 'user', actorId: other.id, action: 'auth.logout', resourceType: 'session', resourceId: randomUUID(), outcome: 'success' }),
    );
    await withTenant(t.app.db, { orgId: PLATFORM_ORG_KEY, actor: 'system', requestId: 'chain' }, (tx) => chainPending(tx, PLATFORM_ORG_KEY));

    const data = await withUser(t.app.db, r(me.id), (tx) => accountExportData(tx, me.id));
    expect(data.memberships).toEqual([expect.objectContaining({ orgId, role: 'editor', status: 'suspended', formsOwned: 1 })]);
    expect(data.activity).toEqual([expect.objectContaining({ action: 'auth.logout', outcome: 'success', resourceType: 'session', userAgent: 'Firefox' })]);
  });

  it('account_delete blocks while an org would be left without an owner or without members, and changes nothing', async () => {
    const solo = await user('solo');
    await org([[solo.id, 'owner']]);
    const owner = await user('owner');
    const member = await user('member');
    const shared = await org([
      [owner.id, 'owner'],
      [member.id, 'editor'],
    ]);
    const orphan = await user('orphan');
    const ownerless = await org([
      [orphan.id, 'editor'],
      [member.id, 'viewer'],
    ]);
    await form(ownerless, orphan.id);

    const soloPlan = await withUser(t.app.db, r(solo.id), (tx) => accountDelete(tx, solo.id, { apply: true }));
    expect(soloPlan).toMatchObject({ status: 'blocked', orgs: [{ role: 'owner', blocker: 'last_member' }] });
    const ownerPlan = await withUser(t.app.db, r(owner.id), (tx) => accountDelete(tx, owner.id, { apply: true }));
    expect(ownerPlan).toMatchObject({ status: 'blocked', orgs: [{ orgId: shared, blocker: 'sole_owner' }] });
    const orphanPlan = await withUser(t.app.db, r(orphan.id), (tx) => accountDelete(tx, orphan.id, { apply: true }));
    expect(orphanPlan).toMatchObject({ status: 'blocked', orgs: [{ orgId: ownerless, formsOwned: 1, formsTo: null, blocker: 'no_owner_for_forms' }] });
    // The member of both may leave: the shared org keeps its owner; the ownerless one has nothing of theirs to hand over.
    const memberPlan = await withUser(t.app.db, r(member.id), (tx) => accountDelete(tx, member.id, { apply: false }));
    expect(memberPlan.status).toBe('ready');
    expect(memberPlan.orgs.map((o) => o.blocker)).toEqual([null, null]);

    const { rows } = await t.owner.query(`select count(*)::int as n from users where id = any($1) and status = 'active'`, [[solo.id, owner.id, orphan.id, member.id]]);
    expect(rows[0].n).toBe(4);
    const kept = await t.owner.query(`select count(*)::int as n from memberships where user_id = any($1)`, [[solo.id, owner.id, orphan.id, member.id]]);
    expect(kept.rows[0].n).toBe(5);
  });

  it('a second owner unblocks the sole owner, and the plan names who takes the forms', async () => {
    const first = await user('first');
    const second = await user('second');
    const orgId = await org([
      [first.id, 'owner'],
      [second.id, 'admin'],
    ]);
    await form(orgId, first.id);
    expect((await withUser(t.app.db, r(first.id), (tx) => accountDelete(tx, first.id, { apply: false }))).status).toBe('blocked');
    await t.owner.query(`update memberships set role = 'owner' where org_id = $1 and user_id = $2`, [orgId, second.id]);
    const plan = await withUser(t.app.db, r(first.id), (tx) => accountDelete(tx, first.id, { apply: false }));
    expect(plan).toMatchObject({ status: 'ready', orgs: [{ orgId, formsOwned: 1, formsTo: second.id, blocker: null }] });
  });

  it('account_delete keeps org data with the org and leaves nothing that names the user', async () => {
    const me = await user('leaver');
    const heir = await user('heir');
    const later = await user('later');
    const orgId = await org([
      [heir.id, 'owner'],
      [me.id, 'owner'],
      [later.id, 'owner'],
    ]);
    const formIds = [await form(orgId, me.id), await form(orgId, me.id)];
    const theirs = await form(orgId, heir.id);
    await equip(me.id);
    await equip(heir.id);

    const result = await withUser(t.app.db, r(me.id), (tx) => accountDelete(tx, me.id, { apply: true }));
    expect(result).toMatchObject({ status: 'deleted', orgsLeft: 1, formsReassigned: 2, sessionsEnded: 1, orgs: [{ orgId, formsTo: heir.id }] });

    // The forms stay in the org, owned by its longest-standing other owner; the edit history keeps the pseudonymous id.
    const forms = await t.owner.query<{ id: string; owner_user_id: string; updated_by: string }>(`select id, owner_user_id, updated_by from forms where org_id = $1 order by id`, [orgId]);
    expect(forms.rows).toHaveLength(3);
    for (const f of forms.rows.filter((x) => formIds.includes(x.id))) expect(f).toMatchObject({ owner_user_id: heir.id, updated_by: me.id });
    expect(forms.rows.find((x) => x.id === theirs)?.owner_user_id).toBe(heir.id);

    const tomb = await t.owner.query(`select * from users where id = $1`, [me.id]);
    expect(tomb.rows[0]).toMatchObject({
      email: `deleted-${me.id}@deleted.invalid`,
      email_norm: `deleted-${me.id}@deleted.invalid`,
      name: null,
      locale: null,
      password_hash: null,
      totp_secret_enc: null,
      recovery_code_hashes: null,
      email_verified_at: null,
      last_login_at: null,
      status: 'deleted',
    });
    expect(tomb.rows[0].deleted_at).toBeInstanceOf(Date);
    expect(await authUserByEmail(t.app.db, me.email)).toBeNull();

    // Only the pseudonymous references remain, and the address and name appear nowhere.
    expect(await referencesTo(me.id)).toEqual(['forms.updated_by', 'user_grievances.user_id', 'user_notice_acks.user_id', 'users.id']);
    expect(await textMentions([me.email, `Name leaver`])).toEqual([]);
    const grievance = await t.owner.query(`select message, status, closed_at from user_grievances where user_id = $1`, [me.id]);
    expect(grievance.rows).toEqual([{ message: null, status: 'closed', closed_at: expect.any(Date) }]);

    // The other owner's account is untouched.
    expect(await referencesTo(heir.id)).toEqual([
      'auth_tokens.user_id',
      'forms.owner_user_id',
      'forms.updated_by',
      'memberships.user_id',
      'sessions.user_id',
      'user_grievances.user_id',
      'user_identities.user_id',
      'user_notice_acks.user_id',
      'users.id',
    ]);

    // Deleting twice finds no account; the address can sign up again.
    expect(pgCode(await failure(withUser(t.app.db, r(me.id), (tx) => accountDelete(tx, me.id, { apply: true }))))).toBe('P0002');
    await t.owner.query(`insert into users (id, email, email_norm) values ($1, $2, $2)`, [randomUUID(), me.email]);
  });

  it('keeps notice acknowledgements append-only and grievances closed to the user’s own edits', async () => {
    const me = await user('acks');
    await equip(me.id);
    const ack = await withUser(t.app.db, r(me.id), (tx) => tx.select({ id: userNoticeAcks.id }).from(userNoticeAcks).where(eq(userNoticeAcks.userId, me.id)));
    expect(ack).toHaveLength(1);
    expect(pgCode(await failure(withUser(t.app.db, r(me.id), (tx) => tx.update(userNoticeAcks).set({ locale: 'hi-IN' }).where(eq(userNoticeAcks.userId, me.id)))))).toBe('42501');
    expect(pgCode(await failure(withUser(t.app.db, r(me.id), (tx) => tx.delete(userNoticeAcks).where(eq(userNoticeAcks.userId, me.id)))))).toBe('42501');
    expect(pgCode(await failure(t.owner.query(`delete from user_notice_acks where user_id = $1`, [me.id])))).toBe('42501');
    expect(pgCode(await failure(withUser(t.app.db, r(me.id), (tx) => tx.update(userGrievances).set({ status: 'closed' }).where(eq(userGrievances.userId, me.id)))))).toBe('42501');
    const answered = withUser(t.app.db, r(me.id), (tx) =>
      tx.insert(userGrievances).values({ id: randomUUID(), userId: me.id, reference: `GRV-${randomRef()}`, category: 'other', message: 'x', status: 'answered', dueAt: new Date(Date.now() + 60_000) }),
    );
    expect(pgCode(await failure(answered))).toBe('42501');
    const late = withUser(t.app.db, r(me.id), (tx) =>
      tx.insert(userGrievances).values({ id: randomUUID(), userId: me.id, reference: `GRV-${randomRef()}`, category: 'other', message: 'x', dueAt: new Date(Date.now() + 91 * 86_400_000) }),
    );
    expect(pgCode(await failure(late))).toBe('23514');
  });
});

/** Every `table.column` of a uuid column in public holding `id` (partitions and audit records aside). */
async function referencesTo(id: string): Promise<string[]> {
  const { rows: cols } = await t.owner.query<{ tbl: string; col: string }>(
    `select c.relname as tbl, a.attname as col from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition and a.attnum > 0 and not a.attisdropped
       and format_type(a.atttypid, a.atttypmod) = 'uuid' and c.relname not like 'audit_%'`,
  );
  const hits: string[] = [];
  for (const { tbl, col } of cols) {
    const { rows } = await t.owner.query(`select 1 from ${tbl} where ${col} = $1 limit 1`, [id]);
    if (rows.length > 0) hits.push(`${tbl}.${col}`);
  }
  return hits.sort();
}

/** Every `table.column` of a text or jsonb column in public whose value contains one of `needles`. */
async function textMentions(needles: string[]): Promise<string[]> {
  const { rows: cols } = await t.owner.query<{ tbl: string; col: string }>(
    `select c.relname as tbl, a.attname as col from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition and a.attnum > 0 and not a.attisdropped
       and format_type(a.atttypid, a.atttypmod) in ('text', 'jsonb', 'text[]')`,
  );
  const hits: string[] = [];
  for (const { tbl, col } of cols) {
    const { rows } = await t.owner.query(`select 1 from ${tbl} where ${col}::text ilike any($1) limit 1`, [needles.map((n) => `%${n}%`)]);
    if (rows.length > 0) hits.push(`${tbl}.${col}`);
  }
  return hits;
}
