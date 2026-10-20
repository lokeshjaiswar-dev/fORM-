import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authCreateUser,
  authTokenTake,
  createOrg,
  formDrafts,
  inviteAccept,
  inviteByToken,
  invites,
  listUserOrgs,
  memberAccessToken,
  membershipFor,
  memberSessionsRevoke,
  memberships,
  orgSettings,
  orgs,
  withTenant,
  withUser,
  type TenantCtx,
} from '../src/index.ts';
import { failure, pgCode, seedTwoOrgs, setupTestDb, type Seed, type TestDb } from './harness.ts';

let t: TestDb;
let seed: Seed;

beforeAll(async () => {
  t = await setupTestDb();
  seed = await seedTwoOrgs(t.owner);
});
afterAll(() => t?.close());

const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const MANAGE = ['forms.read', 'members.manage', 'org.settings'];

async function newUser(o: { verified?: boolean; email?: string } = {}): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = o.email ?? `${id.slice(0, 8)}@orgs.test`;
  expect(
    await authCreateUser(t.app.db, { id, email, emailNorm: email.toLowerCase(), name: null, locale: null, passwordHash: null, emailVerified: o.verified ?? true }),
  ).toBe(true);
  return { id, email };
}

async function newOrg(ownerId: string): Promise<string> {
  const id = randomUUID();
  expect(await withUser(t.app.db, { userId: ownerId, requestId: 'r' }, (tx) => createOrg(tx, { id, slug: `o-${id.slice(0, 8)}`, name: 'Org', userId: ownerId }))).toBe(
    'created',
  );
  return id;
}

const as = (orgId: string, userId: string, perms: string[]): TenantCtx => ({ orgId, actor: 'user', userId, perms, requestId: 'r' });

async function invite(orgId: string, by: string, email: string, o: { expires?: string; role?: string } = {}): Promise<Uint8Array> {
  const token = randomBytes(32);
  await t.owner.query(
    `insert into invites (id, org_id, email, email_norm, role, token_hash, invited_by, expires_at) values ($1, $2, $3, lower($3), $4, $5, $6, now() + $7::interval)`,
    [randomUUID(), orgId, email, o.role ?? 'editor', sha(token), by, o.expires ?? '7 days'],
  );
  return sha(token);
}

describe('create_org', () => {
  it('creates the org with the en-IN defaults, its settings and the caller as owner', async () => {
    const u = await newUser();
    const orgId = await newOrg(u.id);
    expect(await listUserOrgs(t.app.db, u.id)).toEqual([{ orgId, slug: `o-${orgId.slice(0, 8)}`, name: 'Org', role: 'owner' }]);
    const [org] = await withTenant(t.app.db, as(orgId, u.id, MANAGE), (tx) => tx.select().from(orgs));
    expect(org).toMatchObject({ locale: 'en-IN', timeZone: 'Asia/Kolkata', dateFormat: 'DD-MM-YYYY', status: 'active', plan: 'free' });
    const [settings] = await withTenant(t.app.db, as(orgId, u.id, MANAGE), (tx) => tx.select().from(orgSettings));
    expect(settings).toMatchObject({ orgId, editorsApproveNotice: false, inviteDays: 7, updatedBy: u.id });
  });

  it('answers slug_taken for a slug in use and keeps given defaults', async () => {
    const u = await newUser();
    const id = randomUUID();
    const taken = await withUser(t.app.db, { userId: u.id, requestId: 'r' }, (tx) => createOrg(tx, { id, slug: 'demo-taken', name: 'One', userId: u.id }));
    expect(taken).toBe('created');
    const again = await withUser(t.app.db, { userId: u.id, requestId: 'r' }, (tx) =>
      createOrg(tx, { id: randomUUID(), slug: 'demo-taken', name: 'Two', userId: u.id, locale: 'hi-IN', timeZone: 'UTC', dateFormat: 'YYYY-MM-DD' }),
    );
    expect(again).toBe('slug_taken');
  });

  it('refuses another user, an unverified user and a malformed slug', async () => {
    const u = await newUser();
    const other = await newUser();
    const unverified = await newUser({ verified: false });
    const run = (as: string, userId: string, slug = `x-${randomUUID().slice(0, 8)}`) =>
      withUser(t.app.db, { userId: as, requestId: 'r' }, (tx) => createOrg(tx, { id: randomUUID(), slug, name: 'X', userId }));
    expect(pgCode(await failure(run(u.id, other.id)))).toBe('42501');
    expect(pgCode(await failure(run(unverified.id, unverified.id)))).toBe('42501');
    expect(pgCode(await failure(run(u.id, u.id, 'Not A Slug')))).toBe('23514');
    expect(pgCode(await failure(withTenant(t.app.db, { orgId: seed.b.orgId, actor: 'system', requestId: 'r' }, (tx) => createOrg(tx, { id: randomUUID(), slug: 'sys', name: 'X', userId: u.id }))))).toBe('42501');
  });
});

describe('membership_for', () => {
  it('grants editors notice approval when the org allows it', async () => {
    expect(await membershipFor(t.app.db, seed.b.editorId, seed.b.orgId)).toEqual({ role: 'editor', grants: [] });
    await t.owner.query('update org_settings set editors_approve_notice = true where org_id = $1', [seed.b.orgId]);
    try {
      expect(await membershipFor(t.app.db, seed.b.editorId, seed.b.orgId)).toEqual({ role: 'editor', grants: ['compliance.approve_notice'] });
      expect(await membershipFor(t.app.db, seed.b.viewerId, seed.b.orgId)).toEqual({ role: 'viewer', grants: [] });
    } finally {
      await t.owner.query('update org_settings set editors_approve_notice = false where org_id = $1', [seed.b.orgId]);
    }
  });

  it('ignores suspended memberships and deleted orgs', async () => {
    const u = await newUser();
    const orgId = await newOrg(u.id);
    const member = await newUser();
    await t.owner.query(`insert into memberships (org_id, user_id, role, status) values ($1, $2, 'viewer', 'suspended')`, [orgId, member.id]);
    expect(await membershipFor(t.app.db, member.id, orgId)).toBeNull();
    await t.owner.query(`update orgs set status = 'deleted' where id = $1`, [orgId]);
    expect(await membershipFor(t.app.db, u.id, orgId)).toBeNull();
  });
});

describe('permissions under RLS (WSP-03)', () => {
  const draftOf = (s: Seed) => s.b.formIds[0];

  it('a viewer’s draft writes change nothing and inserts are refused', async () => {
    const viewer = as(seed.b.orgId, seed.b.viewerId, ['forms.read', 'submissions.read']);
    const updated = await withTenant(t.app.db, viewer, (tx) => tx.update(formDrafts).set({ draftRev: 99 }).where(eq(formDrafts.formId, draftOf(seed))).returning());
    expect(updated).toEqual([]);
    const deleted = await withTenant(t.app.db, viewer, (tx) => tx.delete(formDrafts).where(eq(formDrafts.formId, draftOf(seed))).returning());
    expect(deleted).toEqual([]);
    const err = await failure(
      withTenant(t.app.db, viewer, (tx) =>
        tx.execute(sql`insert into form_drafts (form_id, org_id, draft, schema_version, size_bytes, updated_by)
                       values (${randomUUID()}, ${seed.b.orgId}, '{}', 2, 2, ${seed.b.viewerId})`),
      ),
    );
    expect(pgCode(err)).toBe('42501');
    const editor = as(seed.b.orgId, seed.b.editorId, ['forms.read', 'forms.edit']);
    const edited = await withTenant(t.app.db, editor, (tx) =>
      tx.update(formDrafts).set({ draftRev: sql`${formDrafts.draftRev} + 1` }).where(eq(formDrafts.formId, draftOf(seed))).returning({ id: formDrafts.formId }),
    );
    expect(edited).toEqual([{ id: draftOf(seed) }]);
  });

  it('org fields and settings change only with org.settings', async () => {
    const editor = as(seed.b.orgId, seed.b.editorId, ['forms.read', 'forms.edit']);
    expect(await withTenant(t.app.db, editor, (tx) => tx.update(orgs).set({ name: 'hijacked' }).returning())).toEqual([]);
    expect(await withTenant(t.app.db, editor, (tx) => tx.update(orgSettings).set({ inviteDays: 30 }).returning())).toEqual([]);
    const admin = as(seed.b.orgId, seed.b.ownerId, MANAGE);
    expect(await withTenant(t.app.db, admin, (tx) => tx.update(orgSettings).set({ inviteDays: 7 }).returning({ orgId: orgSettings.orgId }))).toEqual([{ orgId: seed.b.orgId }]);
  });

  it('members change only with members.manage, but anyone may leave', async () => {
    const u = await newUser();
    const orgId = await newOrg(u.id);
    const member = await newUser();
    const editor = as(orgId, member.id, ['forms.read', 'forms.edit']);
    await t.owner.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'editor')`, [orgId, member.id]);
    expect(await withTenant(t.app.db, editor, (tx) => tx.update(memberships).set({ role: 'owner' }).returning())).toEqual([]);
    expect(pgCode(await failure(withTenant(t.app.db, editor, (tx) => tx.insert(memberships).values({ orgId, userId: randomUUID(), role: 'viewer' }))))).toBe('42501');
    expect(await withTenant(t.app.db, editor, (tx) => tx.delete(memberships).where(eq(memberships.userId, u.id)).returning())).toEqual([]);
    const left = await withTenant(t.app.db, editor, (tx) => tx.delete(memberships).where(eq(memberships.userId, member.id)).returning({ userId: memberships.userId }));
    expect(left).toEqual([{ userId: member.id }]);
    // The membership key and timestamps are not fr_app's to change.
    const owner = as(orgId, u.id, MANAGE);
    expect(pgCode(await failure(withTenant(t.app.db, owner, (tx) => tx.execute(sql`update memberships set user_id = ${member.id} where user_id = ${u.id}`))))).toBe('42501');
  });

  it('keeps an active owner in every org', async () => {
    const u = await newUser();
    const orgId = await newOrg(u.id);
    const owner = as(orgId, u.id, MANAGE);
    const demote = () => withTenant(t.app.db, owner, (tx) => tx.update(memberships).set({ role: 'admin' }).where(eq(memberships.userId, u.id)));
    expect(pgCode(await failure(demote()))).toBe('23514');
    expect(pgCode(await failure(withTenant(t.app.db, owner, (tx) => tx.update(memberships).set({ status: 'suspended' }).where(eq(memberships.userId, u.id)))))).toBe('23514');
    expect(pgCode(await failure(withTenant(t.app.db, owner, (tx) => tx.delete(memberships).where(eq(memberships.userId, u.id)))))).toBe('23514');
    const second = await newUser();
    await withTenant(t.app.db, owner, (tx) => tx.insert(memberships).values({ orgId, userId: second.id, role: 'owner' }));
    await demote();
    expect(await membershipFor(t.app.db, u.id, orgId)).toEqual({ role: 'admin', grants: [] });
    // Two owners demoting each other at once: one of them stays.
    await withTenant(t.app.db, as(orgId, second.id, MANAGE), (tx) => tx.update(memberships).set({ role: 'owner' }).where(eq(memberships.userId, u.id)));
    const results = await Promise.allSettled([
      withTenant(t.app.db, as(orgId, u.id, MANAGE), (tx) => tx.update(memberships).set({ role: 'admin' }).where(eq(memberships.userId, second.id))),
      withTenant(t.app.db, as(orgId, second.id, MANAGE), (tx) => tx.update(memberships).set({ role: 'admin' }).where(eq(memberships.userId, u.id))),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const { rows } = await t.owner.query<{ n: number }>(`select count(*)::int as n from memberships where org_id = $1 and role = 'owner'`, [orgId]);
    expect(rows[0]!.n).toBe(1);
  });
});

describe('invites', () => {
  it('fr_app never reads the token hash', async () => {
    const admin = as(seed.b.orgId, seed.b.ownerId, MANAGE);
    expect(pgCode(await failure(withTenant(t.app.db, admin, (tx) => tx.select().from(invites))))).toBe('42501');
    expect(pgCode(await failure(withTenant(t.app.db, admin, (tx) => tx.execute(sql`select token_hash from invites`))))).toBe('42501');
    const rows = await withTenant(t.app.db, admin, (tx) => tx.select({ id: invites.id }).from(invites));
    expect(rows.length).toBeGreaterThan(0);
    // Without members.manage, a member sees none.
    expect(await withTenant(t.app.db, as(seed.b.orgId, seed.b.editorId, ['forms.read']), (tx) => tx.select({ id: invites.id }).from(invites))).toEqual([]);
  });

  it('invite_by_token describes a link without using it', async () => {
    const u = await newUser();
    const orgId = await newOrg(u.id);
    const hash = await invite(orgId, u.id, 'Asha@Example.test');
    expect(await inviteByToken(t.app.db, hash)).toMatchObject({ orgId, orgName: 'Org', email: 'Asha@Example.test', role: 'editor', inviterName: u.email, state: 'open' });
    expect(await inviteByToken(t.app.db, sha(randomBytes(32)))).toBeNull();
    expect((await inviteByToken(t.app.db, await invite(orgId, u.id, 'late@example.test', { expires: '1 second' })))?.state).toBe('open');
  });

  it('accepts once, for the invited and verified address only', async () => {
    const u = await newUser();
    const orgId = await newOrg(u.id);
    const asha = await newUser({ email: `asha-${randomUUID().slice(0, 6)}@example.test` });
    const other = await newUser();
    const hash = await invite(orgId, u.id, asha.email.toUpperCase());
    const accept = (userId: string, h = hash) => withUser(t.app.db, { userId, requestId: 'r' }, (tx) => inviteAccept(tx, h, userId));
    expect((await accept(other.id)).outcome).toBe('email_mismatch');
    expect(await accept(asha.id)).toMatchObject({ outcome: 'accepted', orgId, role: 'editor' });
    expect(await membershipFor(t.app.db, asha.id, orgId)).toEqual({ role: 'editor', grants: [] });
    expect((await accept(asha.id)).outcome).toBe('used');
    expect((await inviteByToken(t.app.db, hash))?.state).toBe('used');
    expect((await accept(asha.id, sha(randomBytes(32)))).outcome).toBe('unknown');
    // Already a member: the invite is used, the role stays.
    expect(await accept(asha.id, await invite(orgId, u.id, asha.email, { role: 'admin' }))).toMatchObject({ outcome: 'already_member', role: 'editor' });
    // Only for oneself.
    expect(pgCode(await failure(withUser(t.app.db, { userId: other.id, requestId: 'r' }, (tx) => inviteAccept(tx, hash, asha.id))))).toBe('42501');
  });

  it('rejects expired, revoked and unverified acceptances and adds no member', async () => {
    const u = await newUser();
    const orgId = await newOrg(u.id);
    const late = await newUser();
    const expired = await invite(orgId, u.id, late.email, { expires: '1 millisecond' });
    await new Promise((r) => setTimeout(r, 20));
    const accept = (userId: string, h: Uint8Array) => withUser(t.app.db, { userId, requestId: 'r' }, (tx) => inviteAccept(tx, h, userId));
    expect((await inviteByToken(t.app.db, expired))?.state).toBe('expired');
    expect((await accept(late.id, expired)).outcome).toBe('expired');
    expect(await membershipFor(t.app.db, late.id, orgId)).toBeNull();

    const unverified = await newUser({ verified: false });
    expect((await accept(unverified.id, await invite(orgId, u.id, unverified.email))).outcome).toBe('email_not_verified');

    const revokedHash = await invite(orgId, u.id, `r-${late.email}`);
    await withTenant(t.app.db, as(orgId, u.id, MANAGE), (tx) => tx.update(invites).set({ revokedAt: new Date() }).where(eq(invites.emailNorm, `r-${late.email}`)));
    expect((await inviteByToken(t.app.db, revokedHash))?.state).toBe('revoked');
    // Final: a revoked invite cannot be reopened.
    const reopen = withTenant(t.app.db, as(orgId, u.id, MANAGE), (tx) => tx.update(invites).set({ revokedAt: null }).where(eq(invites.emailNorm, `r-${late.email}`)));
    expect(pgCode(await failure(reopen))).toBe('42501');
  });

  it('allows one open invite per address and org', async () => {
    const u = await newUser();
    const orgId = await newOrg(u.id);
    await invite(orgId, u.id, 'twice@example.test');
    expect(pgCode(await failure(invite(orgId, u.id, 'twice@example.test')))).toBe('23505');
  });
});

describe('member_sessions_revoke', () => {
  it('revokes the member’s sessions bound to the org, with members.manage only', async () => {
    const u = await newUser();
    const orgId = await newOrg(u.id);
    const member = await newUser();
    await t.owner.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')`, [orgId, member.id]);
    const session = (activeOrg: string | null) =>
      t.owner
        .query<{ id: string }>(
          `insert into sessions (id, token_hash, user_id, active_org_id, mfa_level, idle_expires_at, absolute_expires_at)
           values ($1, $2, $3, $4, 'pwd', now() + interval '1 hour', now() + interval '1 day') returning id`,
          [randomUUID(), randomBytes(32), member.id, activeOrg],
        )
        .then((r) => r.rows[0]!.id);
    const bound = await session(orgId);
    const elsewhere = await session(null);
    expect(pgCode(await failure(withTenant(t.app.db, as(orgId, member.id, ['forms.read']), (tx) => memberSessionsRevoke(tx, member.id))))).toBe('42501');
    expect(await withTenant(t.app.db, as(orgId, u.id, MANAGE), (tx) => memberSessionsRevoke(tx, member.id))).toBe(1);
    const { rows } = await t.owner.query<{ id: string; revoked_reason: string | null }>('select id, revoked_reason from sessions where user_id = $1', [member.id]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.revoked_reason]))).toEqual({ [bound]: 'role_changed', [elsewhere]: null });
    // Someone else's org: nothing.
    expect(await withTenant(t.app.db, as(seed.b.orgId, seed.b.ownerId, MANAGE), (tx) => memberSessionsRevoke(tx, member.id))).toBe(0);
  });
});

describe('member_access_token (BL-203)', () => {
  it('issues a single-use reset or verification token for a member of this org only', async () => {
    const owner = await newUser();
    const orgId = await newOrg(owner.id);
    const admin = await newUser();
    const editor = await newUser();
    const unverified = await newUser({ verified: false });
    const elsewhere = await newUser();
    for (const [id, role] of [
      [admin.id, 'admin'],
      [editor.id, 'editor'],
      [unverified.id, 'viewer'],
      [elsewhere.id, 'viewer'],
    ] as const) {
      await t.owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, id, role]);
    }
    await t.owner.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')`, [seed.a.orgId, elsewhere.id]);
    const issue = (by: string, target: string, token = randomBytes(32)) =>
      withTenant(t.app.db, as(orgId, by, MANAGE), (tx) => memberAccessToken(tx, { userId: target, tokenId: randomUUID(), tokenHash: sha(token), minutes: 60 }));

    const token = randomBytes(32);
    expect(await issue(admin.id, editor.id, token)).toEqual({ outcome: 'issued', purpose: 'password_reset' });
    expect(await authTokenTake(t.app.db, sha(token), 'password_reset')).toMatchObject({ userId: editor.id });
    expect(await issue(admin.id, unverified.id)).toEqual({ outcome: 'issued', purpose: 'verify_email' });
    expect((await issue(admin.id, owner.id)).outcome).toBe('forbidden');
    expect((await issue(admin.id, admin.id)).outcome).toBe('forbidden');
    expect((await issue(owner.id, admin.id)).outcome).toBe('issued');
    expect((await issue(admin.id, elsewhere.id)).outcome).toBe('other_orgs');
    expect((await issue(admin.id, seed.b.editorId)).outcome).toBe('not_a_member');
    expect(pgCode(await failure(withTenant(t.app.db, as(orgId, editor.id, ['forms.read']), (tx) => memberAccessToken(tx, { userId: admin.id, tokenId: randomUUID(), tokenHash: sha(randomBytes(32)), minutes: 60 }))))).toBe('42501');
  });
});

describe('audit_pending (BL-193)', () => {
  it('takes occurred_at from the database clock', async () => {
    const ctx: TenantCtx = { orgId: seed.b.orgId, actor: 'system', requestId: 'r' };
    const err = await failure(withTenant(t.app.db, ctx, (tx) => tx.execute(sql`insert into audit_pending (org_key, event, occurred_at) values (${seed.b.orgId}, '{}', now() + interval '10 years')`)));
    expect(pgCode(err)).toBe('42501');
    await withTenant(t.app.db, ctx, (tx) => tx.execute(sql`insert into audit_pending (org_key, event) values (${seed.b.orgId}, '{}')`));
  });
});
