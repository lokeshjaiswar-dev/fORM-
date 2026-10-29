import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, formDrafts, provision, withTenant, type DbHandle } from '@form/db';
import type { MailMessage, Mailer } from '@form/ports';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { tenantOf } from '../src/auth.ts';
import { parseConfig } from '../src/config.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

const BUILDER = 'https://app.form.test';
/** What the builder's fetch sends on every unsafe request (ADR-0008). */
const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const ZERO = '00000000-0000-0000-0000-000000000000';

let owner: pg.Pool;
let chainer: DbHandle;
let app: FastifyInstance;
let smtpApp: FastifyInstance;
const sent: MailMessage[] = [];
const mailer: Mailer = {
  async send(m) {
    sent.push(m);
    return { messageId: `<${randomUUID()}@test>`, refused: [] };
  },
  async verify() {
    return { ok: true };
  },
};

function config(env: Record<string, string>) {
  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent', PUBLIC_BUILDER_URL: BUILDER, ...env });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.config;
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_orgs');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  chainer = createDb(urls.fr_app, { max: 2, applicationName: 'fr-api-test-orgs' });
  app = await buildApp(config({ DATABASE_URL: urls.fr_app, MAILER_DRIVER: 'log' }), { mailer, underPressure: false });
  // A route that writes a draft and checks forms.edit, as the draft routes of WP-1.06 will; and one that forgets to.
  for (const [path, perm] of [
    ['/v1/test-only/drafts/:id', 'forms.edit'],
    ['/v1/test-only/unchecked-drafts/:id', 'forms.read'],
  ] as const) {
    app.put(path, { config: { auth: 'user', perm } }, async (request) => {
      const { id } = request.params as { id: string };
      const rows = await withTenant(chainer.db, tenantOf(request), (tx) =>
        tx.update(formDrafts).set({ draft: { blocks: [] }, updatedBy: tenantOf(request).userId! }).where(eq(formDrafts.formId, id)).returning({ id: formDrafts.formId }),
      );
      return { updated: rows.length };
    });
  }
  smtpApp = await buildApp(config({ DATABASE_URL: urls.fr_app, MAILER_DRIVER: 'smtp' }), { mailer, underPressure: false });
});

afterAll(async () => {
  await app?.close();
  await smtpApp?.close();
  await chainer?.close();
  await owner?.end();
});

interface User {
  id: string;
  email: string;
}

async function newUser(o: { verified?: boolean } = {}): Promise<User> {
  const id = randomUUID();
  const email = `u-${id.slice(0, 8)}@orgs.test`;
  await owner.query('insert into users (id, email, email_norm, name, email_verified_at) values ($1, $2, $2, $3, $4)', [
    id,
    email,
    `User ${id.slice(0, 4)}`,
    o.verified === false ? null : new Date(),
  ]);
  return { id, email };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** As a user through the development header, optionally in an org. */
async function as(user: User, method: Method, url: string, o: { org?: string; body?: unknown; target?: FastifyInstance } = {}) {
  return (o.target ?? app).inject({
    method,
    url,
    headers: { 'x-fr-dev-user': user.id, ...(o.org ? { 'x-fr-org': o.org } : {}) },
    ...(o.body === undefined ? {} : { payload: o.body as Record<string, unknown> }),
  });
}

/** A live session for the user (as sign-in would issue one), and requests that ride on its cookie. */
async function session(user: User) {
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  await owner.query(
    `insert into sessions (id, token_hash, user_id, mfa_level, idle_expires_at, absolute_expires_at) values ($1, $2, $3, 'pwd', now() + interval '1 hour', now() + interval '1 day')`,
    [id, createHash('sha256').update(token).digest(), user.id],
  );
  const send = (method: Method, url: string, o: { org?: string; body?: unknown; crossSite?: boolean } = {}) =>
    app.inject({
      method,
      url,
      headers: { cookie: `__Host-fr_sess=${token}`, ...(method === 'GET' || o.crossSite ? {} : BROWSER), ...(o.org ? { 'x-fr-org': o.org } : {}) },
      ...(o.body === undefined ? {} : { payload: o.body as Record<string, unknown> }),
    });
  return { id, send };
}

async function createOrg(user: User, body: Record<string, unknown> = {}): Promise<string> {
  const res = await as(user, 'POST', '/v1/orgs', { body: { name: 'Acme Pvt. Ltd.', ...body } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ org: { id: string } }>().org.id;
}

async function addMember(orgId: string, user: User, role: string): Promise<void> {
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, user.id, role]);
}

async function pending(orgKey: string): Promise<Array<{ action: string; outcome: string; reason?: string; actorId?: string }>> {
  const { rows } = await owner.query<{ event: { action: string; outcome: string; reason?: string; actorId?: string } }>(
    'select event from audit_pending where org_key = $1 order by id',
    [orgKey],
  );
  return rows.map((r) => r.event);
}

const linkToken = (link: string) => /#token=([A-Za-z0-9_-]{43})$/.exec(link)![1]!;

describe('orgs', () => {
  it('creates an org with the en-IN defaults; the creator owns it', async () => {
    const asha = await newUser();
    const res = await as(asha, 'POST', '/v1/orgs', { body: { name: 'Acme Pvt. Ltd.' } });
    expect(res.statusCode).toBe(201);
    const { org } = res.json<{ org: Record<string, unknown> }>();
    expect(org).toMatchObject({ slug: 'acme-pvt-ltd', name: 'Acme Pvt. Ltd.', locale: 'en-IN', timeZone: 'Asia/Kolkata', dateFormat: 'DD-MM-YYYY', plan: 'free', status: 'active' });
    expect((await as(asha, 'GET', '/v1/orgs')).json()).toEqual({ items: [{ id: org.id, slug: 'acme-pvt-ltd', name: 'Acme Pvt. Ltd.', role: 'owner' }], activeOrgId: null });
    const mine = await as(asha, 'GET', '/v1/org', { org: org.id as string });
    expect(mine.json()).toMatchObject({ org: { id: org.id }, role: 'owner', permissions: expect.arrayContaining(['members.manage', 'billing.manage', 'data.route']) });
    expect(await pending(org.id as string)).toEqual([expect.objectContaining({ action: 'org.created', outcome: 'success', actorId: asha.id })]);
  });

  it('makes another slug when the plain one is taken, and refuses a taken slug given explicitly', async () => {
    const u = await newUser();
    const first = await as(u, 'POST', '/v1/orgs', { body: { name: 'Globex' } });
    const second = await as(u, 'POST', '/v1/orgs', { body: { name: 'Globex' } });
    expect(first.json()).toMatchObject({ org: { slug: expect.stringMatching(/^globex(-[0-9a-f]{6})?$/) } });
    expect(second.json<{ org: { slug: string } }>().org.slug).not.toBe(first.json<{ org: { slug: string } }>().org.slug);
    const taken = await as(u, 'POST', '/v1/orgs', { body: { name: 'Other', slug: first.json<{ org: { slug: string } }>().org.slug } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: 'SLUG_TAKEN' });
  });

  it('takes valid defaults and refuses bad ones', async () => {
    const u = await newUser();
    const ok = await as(u, 'POST', '/v1/orgs', { body: { name: 'Initech', locale: 'hi-in', timeZone: 'Europe/London', dateFormat: 'YYYY-MM-DD' } });
    expect(ok.json()).toMatchObject({ org: { locale: 'hi-IN', timeZone: 'Europe/London', dateFormat: 'YYYY-MM-DD' } });
    for (const body of [{ name: 'X', timeZone: 'Mars/Olympus' }, { name: 'X', locale: '!!' }, { name: 'X', dateFormat: 'DD.MM.YY' }, { name: 'X', slug: 'Bad Slug' }, { name: 'a\nb' }]) {
      const res = await as(u, 'POST', '/v1/orgs', { body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('needs a verified address to create an org', async () => {
    const res = await as(await newUser({ verified: false }), 'POST', '/v1/orgs', { body: { name: 'Nope' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  it('changes the org and its settings with org.settings only, and audits the refusal', async () => {
    const o = await newUser();
    const orgId = await createOrg(o);
    const editor = await newUser();
    await addMember(orgId, editor, 'editor');
    const refused = await as(editor, 'PATCH', '/v1/org', { org: orgId, body: { name: 'Mine now' } });
    expect(refused.statusCode).toBe(403);
    expect((await pending(orgId)).at(-1)).toMatchObject({ action: 'request.authorize', outcome: 'denied', reason: 'missing_permission:org.settings', actorId: editor.id });
    const renamed = await as(o, 'PATCH', '/v1/org', { org: orgId, body: { name: 'Acme India', timeZone: 'UTC' } });
    expect(renamed.json()).toMatchObject({ org: { name: 'Acme India', timeZone: 'UTC', locale: 'en-IN' } });
    expect((await as(o, 'PATCH', '/v1/org', { org: orgId, body: {} })).statusCode).toBe(400);

    expect((await as(o, 'GET', '/v1/org/settings', { org: orgId })).json()).toEqual({ editorsApproveNotice: false, inviteDays: 7 });
    expect((await as(editor, 'GET', '/v1/org', { org: orgId })).json<{ permissions: string[] }>().permissions).not.toContain('compliance.approve_notice');
    expect((await as(o, 'PATCH', '/v1/org/settings', { org: orgId, body: { editorsApproveNotice: true } })).json()).toEqual({ editorsApproveNotice: true, inviteDays: 7 });
    // CMP-24: approving notices is now granted to editors.
    expect((await as(editor, 'GET', '/v1/org', { org: orgId })).json<{ permissions: string[] }>().permissions).toContain('compliance.approve_notice');
    expect((await as(editor, 'PATCH', '/v1/org/settings', { org: orgId, body: { inviteDays: 30 } })).statusCode).toBe(403);
    expect((await pending(orgId)).map((e) => e.action)).toEqual(expect.arrayContaining(['org.updated', 'org.settings_updated']));
  });

  it('keeps every org to its members: another org’s id is refused, and its members are not found', async () => {
    const a = await newUser();
    const b = await newUser();
    const orgA = await createOrg(a);
    const orgB = await createOrg(b);
    expect((await as(a, 'GET', '/v1/org', { org: orgB })).statusCode).toBe(403);
    expect((await as(a, 'PATCH', `/v1/org/members/${b.id}`, { org: orgA, body: { role: 'viewer' } })).statusCode).toBe(404);
    expect((await as(a, 'DELETE', `/v1/org/members/${b.id}`, { org: orgA })).statusCode).toBe(404);
    const members = (await as(a, 'GET', '/v1/org/members', { org: orgA })).json<{ items: { userId: string }[]; accessLinks: boolean }>();
    expect(members.items.map((m) => m.userId)).toEqual([a.id]);
    expect(members.accessLinks).toBe(true);
    expect((await as(a, 'GET', '/v1/org/members', { org: orgA, target: smtpApp })).json()).toMatchObject({ accessLinks: false });
    expect((await pending(ZERO)).at(-1)).toMatchObject({ action: 'request.authorize', reason: 'not_a_member', actorId: a.id });
  });
});

describe('roles (WSP-03)', () => {
  it('refuses a viewer’s draft write with an audited 403, and RLS changes nothing when a route forgets the check', async () => {
    const o = await newUser();
    const orgId = await createOrg(o);
    const viewer = await newUser();
    const editor = await newUser();
    await addMember(orgId, viewer, 'viewer');
    await addMember(orgId, editor, 'editor');
    const formId = randomUUID();
    await owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [formId, orgId, randomUUID(), o.id, 'Survey']);
    await owner.query(`insert into form_drafts (form_id, org_id, draft, schema_version, size_bytes, updated_by) values ($1, $2, '{"v":1}', 2, 7, $3)`, [formId, orgId, o.id]);

    const refused = await as(viewer, 'PUT', `/v1/test-only/drafts/${formId}`, { org: orgId });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'FORBIDDEN', detail: 'Requires forms.edit.' });
    expect((await pending(orgId)).at(-1)).toMatchObject({ action: 'request.authorize', outcome: 'denied', reason: 'missing_permission:forms.edit', actorId: viewer.id });

    expect((await as(viewer, 'PUT', `/v1/test-only/unchecked-drafts/${formId}`, { org: orgId })).json()).toEqual({ updated: 0 });
    const { rows } = await owner.query<{ draft: unknown }>('select draft from form_drafts where form_id = $1', [formId]);
    expect(rows[0]!.draft).toEqual({ v: 1 });
    expect((await as(editor, 'PUT', `/v1/test-only/drafts/${formId}`, { org: orgId })).json()).toEqual({ updated: 1 });
  });

  it('lists members, and lets owners and admins change roles within their reach', async () => {
    const o = await newUser();
    const orgId = await createOrg(o);
    const admin = await newUser();
    const editor = await newUser();
    const viewer = await newUser();
    await addMember(orgId, admin, 'admin');
    await addMember(orgId, editor, 'editor');
    await addMember(orgId, viewer, 'viewer');
    const list = await as(viewer, 'GET', '/v1/org/members', { org: orgId });
    expect(list.json<{ items: { userId: string; role: string }[] }>().items.map((m) => [m.userId, m.role])).toEqual([
      [o.id, 'owner'],
      [admin.id, 'admin'],
      [editor.id, 'editor'],
      [viewer.id, 'viewer'],
    ]);

    expect((await as(viewer, 'PATCH', `/v1/org/members/${editor.id}`, { org: orgId, body: { role: 'viewer' } })).statusCode).toBe(403);
    expect((await as(admin, 'PATCH', `/v1/org/members/${o.id}`, { org: orgId, body: { role: 'viewer' } })).statusCode).toBe(403);
    expect((await as(admin, 'PATCH', `/v1/org/members/${editor.id}`, { org: orgId, body: { role: 'owner' } })).statusCode).toBe(403);
    expect((await as(admin, 'PATCH', `/v1/org/members/${admin.id}`, { org: orgId, body: { role: 'owner' } })).statusCode).toBe(403);
    const promoted = await as(admin, 'PATCH', `/v1/org/members/${viewer.id}`, { org: orgId, body: { role: 'editor' } });
    expect(promoted.json()).toEqual({ userId: viewer.id, role: 'editor', status: 'active', sessionsRevoked: 0 });
    expect((await as(viewer, 'GET', '/v1/org', { org: orgId })).json<{ permissions: string[] }>().permissions).toContain('forms.edit');
    const suspended = await as(o, 'PATCH', `/v1/org/members/${editor.id}`, { org: orgId, body: { status: 'suspended' } });
    expect(suspended.json()).toMatchObject({ status: 'suspended' });
    expect((await as(editor, 'GET', '/v1/org', { org: orgId })).statusCode).toBe(403);
    expect((await pending(orgId)).filter((e) => e.action === 'member.updated')).toHaveLength(2);
  });

  it('keeps the last owner, lets members leave and owners remove', async () => {
    const o = await newUser();
    const orgId = await createOrg(o);
    const editor = await newUser();
    const viewer = await newUser();
    await addMember(orgId, editor, 'editor');
    await addMember(orgId, viewer, 'viewer');
    const leave = await as(o, 'DELETE', `/v1/org/members/${o.id}`, { org: orgId });
    expect(leave.statusCode).toBe(409);
    expect(leave.json()).toMatchObject({ code: 'LAST_OWNER' });
    expect((await as(editor, 'DELETE', `/v1/org/members/${viewer.id}`, { org: orgId })).statusCode).toBe(403);
    expect((await as(editor, 'DELETE', `/v1/org/members/${editor.id}`, { org: orgId })).statusCode).toBe(204);
    expect((await as(o, 'DELETE', `/v1/org/members/${viewer.id}`, { org: orgId })).statusCode).toBe(204);
    expect((await as(viewer, 'GET', '/v1/org', { org: orgId })).statusCode).toBe(403);
    expect((await pending(orgId)).filter((e) => e.action === 'member.removed').map((e) => e.reason)).toEqual(['left', 'removed']);
  });
});

describe('invites', () => {
  it('invites by email, describes the link, and adds the invitee once', async () => {
    const o = await newUser();
    const orgId = await createOrg(o);
    const asha = await newUser();
    const before = sent.length;
    const res = await as(o, 'POST', '/v1/org/invites', { org: orgId, body: { email: asha.email.toUpperCase(), role: 'editor' } });
    expect(res.statusCode).toBe(201);
    const { invite, link, emailed } = res.json<{ invite: { id: string; state: string; email: string }; link: string; emailed: boolean }>();
    expect(invite).toMatchObject({ state: 'open', email: asha.email.toUpperCase() });
    expect(link).toMatch(new RegExp(`^${BUILDER}/invite#token=[A-Za-z0-9_-]{43}$`));
    expect(emailed).toBe(false);
    expect(sent.slice(before).map((m) => [m.to[0]!.address, m.subject])).toEqual([[asha.email.toUpperCase(), expect.stringMatching(/invited you to Acme Pvt\. Ltd\./)]]);

    const token = linkToken(link);
    const lookup = await app.inject({ method: 'POST', url: '/v1/invites/lookup', payload: { token } });
    expect(lookup.json()).toMatchObject({ orgName: 'Acme Pvt. Ltd.', role: 'editor', state: 'open' });
    expect((await as(o, 'GET', '/v1/org/invites', { org: orgId })).json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual([invite.id]);

    const accepted = await as(asha, 'POST', '/v1/invites/accept', { body: { token } });
    expect(accepted.json()).toEqual({ org: { id: orgId, slug: expect.any(String), name: 'Acme Pvt. Ltd.', role: 'editor' }, outcome: 'accepted' });
    expect((await as(asha, 'GET', '/v1/org', { org: orgId })).json()).toMatchObject({ role: 'editor' });
    const again = await as(asha, 'POST', '/v1/invites/accept', { body: { token } });
    expect(again.statusCode).toBe(410);
    expect(again.json()).toMatchObject({ code: 'INVITE_UNAVAILABLE' });
    expect((await as(o, 'GET', '/v1/org/invites', { org: orgId })).json()).toEqual({ items: [] });
    expect((await pending(orgId)).filter((e) => e.action.startsWith('member.')).map((e) => [e.action, e.outcome, e.reason])).toEqual([
      ['member.invited', 'success', undefined],
      ['member.joined', 'success', 'accepted'],
      ['member.joined', 'denied', 'used'],
    ]);
    // Inviting a member again is refused.
    expect((await as(o, 'POST', '/v1/org/invites', { org: orgId, body: { email: asha.email } })).statusCode).toBe(409);
  });

  it('rejects an expired invite, and adds nobody', async () => {
    const o = await newUser();
    const orgId = await createOrg(o);
    const late = await newUser();
    const { link, invite } = (await as(o, 'POST', '/v1/org/invites', { org: orgId, body: { email: late.email, role: 'viewer' } })).json<{ link: string; invite: { id: string } }>();
    await owner.query(`update invites set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = $1`, [invite.id]);
    const token = linkToken(link);
    expect((await app.inject({ method: 'POST', url: '/v1/invites/lookup', payload: { token } })).json()).toMatchObject({ state: 'expired' });
    const res = await as(late, 'POST', '/v1/invites/accept', { body: { token } });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ code: 'INVITE_UNAVAILABLE', detail: expect.stringMatching(/expired/) });
    expect((await as(late, 'GET', '/v1/orgs')).json()).toMatchObject({ items: [] });
    expect((await pending(orgId)).at(-1)).toMatchObject({ action: 'member.joined', outcome: 'denied', reason: 'expired', actorId: late.id });
    expect((await as(o, 'GET', '/v1/org/invites', { org: orgId })).json()).toMatchObject({ items: [{ id: invite.id, state: 'expired' }] });
  });

  it('accepts only for the invited, verified address; replaced and withdrawn links stop working', async () => {
    const o = await newUser();
    const orgId = await createOrg(o);
    const invitee = await newUser();
    const someoneElse = await newUser();
    const first = (await as(o, 'POST', '/v1/org/invites', { org: orgId, body: { email: invitee.email } })).json<{ link: string }>();
    const second = (await as(o, 'POST', '/v1/org/invites', { org: orgId, body: { email: invitee.email } })).json<{ link: string; invite: { id: string } }>();
    expect((await as(invitee, 'POST', '/v1/invites/accept', { body: { token: linkToken(first.link) } })).json()).toMatchObject({ code: 'INVITE_UNAVAILABLE', detail: expect.stringMatching(/withdrawn/) });
    const mismatch = await as(someoneElse, 'POST', '/v1/invites/accept', { body: { token: linkToken(second.link) } });
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json()).toMatchObject({ code: 'INVITE_EMAIL_MISMATCH' });
    expect((await as(o, 'DELETE', `/v1/org/invites/${second.invite.id}`, { org: orgId })).statusCode).toBe(204);
    expect((await as(o, 'DELETE', `/v1/org/invites/${second.invite.id}`, { org: orgId })).statusCode).toBe(404);
    expect((await as(invitee, 'POST', '/v1/invites/accept', { body: { token: linkToken(second.link) } })).statusCode).toBe(410);
    expect((await app.inject({ method: 'POST', url: '/v1/invites/lookup', payload: { token: randomBytes(32).toString('base64url') } })).statusCode).toBe(410);
    const reasons = (await pending(orgId)).filter((e) => e.action === 'member.joined').map((e) => e.reason);
    expect(reasons).toEqual(['revoked', 'email_mismatch', 'revoked']);
  });

  it('lets only owners invite owners, and members.manage invite at all', async () => {
    const o = await newUser();
    const orgId = await createOrg(o);
    const admin = await newUser();
    const editor = await newUser();
    await addMember(orgId, admin, 'admin');
    await addMember(orgId, editor, 'editor');
    expect((await as(editor, 'POST', '/v1/org/invites', { org: orgId, body: { email: 'x@orgs.test' } })).statusCode).toBe(403);
    expect((await as(admin, 'POST', '/v1/org/invites', { org: orgId, body: { email: 'x@orgs.test', role: 'owner' } })).statusCode).toBe(403);
    expect((await as(admin, 'POST', '/v1/org/invites', { org: orgId, body: { email: 'x@orgs.test', role: 'admin' } })).statusCode).toBe(201);
    expect((await as(o, 'POST', '/v1/org/invites', { org: orgId, body: { email: 'y@orgs.test', role: 'owner' } })).statusCode).toBe(201);
    expect((await as(editor, 'GET', '/v1/org/invites', { org: orgId })).statusCode).toBe(403);
  });
});

describe('sessions and the org switcher', () => {
  it('remembers the chosen org, uses it when a request names none, and refuses an org the user is not in', async () => {
    const o = await newUser();
    const orgId = await createOrg(o);
    const other = await createOrg(await newUser());
    const s = await session(o);
    expect((await s.send('GET', '/v1/forms')).statusCode).toBe(400);
    expect((await s.send('PUT', '/v1/me/active-org', { body: { orgId: other } })).statusCode).toBe(403);
    expect((await s.send('PUT', '/v1/me/active-org', { body: { orgId } })).statusCode).toBe(204);
    expect((await s.send('GET', '/v1/me')).json()).toMatchObject({ activeOrgId: orgId, orgs: [{ id: orgId }] });
    expect((await s.send('GET', '/v1/forms')).statusCode).toBe(200);
    expect((await s.send('GET', '/v1/org')).json()).toMatchObject({ org: { id: orgId }, role: 'owner' });
    expect((await pending(orgId)).at(-1)).toMatchObject({ action: 'org.switched', actorId: o.id });
    // A cross-site page cannot switch it.
    const forged = await s.send('PUT', '/v1/me/active-org', { body: { orgId: other }, crossSite: true });
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toMatchObject({ code: 'CSRF_REJECTED' });
  });

  it('revokes a member’s sessions bound to the org when their role changes', async () => {
    const o = await newUser();
    const orgId = await createOrg(o);
    const member = await newUser();
    await addMember(orgId, member, 'viewer');
    const s = await session(member);
    expect((await s.send('PUT', '/v1/me/active-org', { body: { orgId } })).statusCode).toBe(204);
    const elsewhere = await session(member);
    const res = await as(o, 'PATCH', `/v1/org/members/${member.id}`, { org: orgId, body: { role: 'editor' } });
    expect(res.json()).toMatchObject({ role: 'editor', sessionsRevoked: 1 });
    expect((await s.send('GET', '/v1/me')).statusCode).toBe(401);
    expect((await elsewhere.send('GET', '/v1/org', { org: orgId })).json()).toMatchObject({ role: 'editor' });
  });

  it('creating and joining an org make it the session’s active org', async () => {
    const o = await newUser();
    const s = await session(o);
    const created = await s.send('POST', '/v1/orgs', { body: { name: 'Session Org' } });
    expect(created.statusCode).toBe(201);
    const orgId = created.json<{ org: { id: string } }>().org.id;
    expect((await s.send('GET', '/v1/orgs')).json()).toMatchObject({ activeOrgId: orgId });

    const joiner = await newUser();
    const { link } = (await as(o, 'POST', '/v1/org/invites', { org: orgId, body: { email: joiner.email } })).json<{ link: string }>();
    const js = await session(joiner);
    expect((await js.send('POST', '/v1/invites/accept', { body: { token: linkToken(link) } })).statusCode).toBe(200);
    expect((await js.send('GET', '/v1/me')).json()).toMatchObject({ activeOrgId: orgId });
  });
});

describe('access links without email (BL-203)', () => {
  it('gives an admin a one-time reset link for a member of this org only', async () => {
    const o = await newUser();
    const orgId = await createOrg(o);
    const admin = await newUser();
    const editor = await newUser();
    const shared = await newUser();
    await addMember(orgId, admin, 'admin');
    await addMember(orgId, editor, 'editor');
    await addMember(orgId, shared, 'viewer');
    await createOrg(shared);
    const res = await as(admin, 'POST', `/v1/org/members/${editor.id}/access-link`, { org: orgId });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ purpose: 'password_reset', link: expect.stringMatching(new RegExp(`^${BUILDER}/auth/reset#token=`)) });
    const { rows } = await owner.query<{ n: number }>(`select count(*)::int as n from auth_tokens where user_id = $1 and purpose = 'password_reset' and consumed_at is null`, [editor.id]);
    expect(rows[0]!.n).toBe(1);
    expect((await as(admin, 'POST', `/v1/org/members/${o.id}/access-link`, { org: orgId })).statusCode).toBe(403);
    expect((await as(admin, 'POST', `/v1/org/members/${shared.id}/access-link`, { org: orgId })).json()).toMatchObject({ code: 'FORBIDDEN', detail: expect.stringMatching(/other orgs/) });
    expect((await as(editor, 'POST', `/v1/org/members/${admin.id}/access-link`, { org: orgId })).statusCode).toBe(403);
    expect((await pending(orgId)).filter((e) => e.action === 'member.access_link_issued')).toEqual([expect.objectContaining({ outcome: 'success', reason: 'password_reset', actorId: admin.id })]);
  });

  it('is unavailable where the server sends email', async () => {
    const o = await newUser();
    const orgId = await createOrg(o);
    const editor = await newUser();
    await addMember(orgId, editor, 'editor');
    const res = await as(o, 'POST', `/v1/org/members/${editor.id}/access-link`, { org: orgId, target: smtpApp });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'FEATURE_UNAVAILABLE' });
    const invited = await as(o, 'POST', '/v1/org/invites', { org: orgId, body: { email: 'z@orgs.test' }, target: smtpApp });
    expect(invited.json()).toMatchObject({ emailed: true });
  });
});
