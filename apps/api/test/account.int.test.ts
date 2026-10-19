import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createKeyfileKeyProvider, createSmtpMailer } from '@form/adapters';
import { chainPending, createDb, PLATFORM_ORG_KEY, provision, withTenant, type DbHandle } from '@form/db';
import { createTestDatabase, startSmtpSink, type SmtpSink } from '@form/testkit';
import { buildApp, type AppDeps } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { NOTICE_VERSION } from '../src/modules/account/notice.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

/*
 * WP-1.31 acceptance against Postgres and SMTP: the notice version is recorded at sign-up; a user exports and deletes
 * their account; deletion keeps org data with the org, passes the user's forms to another owner, and is refused while
 * the user is an org's only owner.
 */

const BUILDER = 'https://app.form.test';
const PASSWORD = 'violet-anchor-teapot-91';
const PRIVACY = 'privacy@form.test';
const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const ROOMY = {
  auth_any: { max: 10_000, windowSeconds: 60 },
  auth_login: { max: 1000, windowSeconds: 900 },
  auth_account: { max: 1000, windowSeconds: 3600 },
  auth_mfa: { max: 1000, windowSeconds: 3600 },
  auth_mail: { max: 1000, windowSeconds: 3600 },
};

let urls: Awaited<ReturnType<typeof provision>>['urls'];
let owner: pg.Pool;
let chainer: DbHandle;
let sink: SmtpSink;
let app: FastifyInstance;
const apps: FastifyInstance[] = [];

async function start(env: Record<string, string> = {}, deps: AppDeps = {}): Promise<FastifyInstance> {
  const parsed = parseConfig({
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'saas',
    DATABASE_URL: urls.fr_app,
    LOG_LEVEL: 'silent',
    PUBLIC_BUILDER_URL: BUILDER,
    AUTH_SECRET: randomBytes(32).toString('base64url'),
    PASSWORD_BREACH_CHECK: 'off',
    PRIVACY_FIDUCIARY_NAME: 'fORM- Test Operator',
    PRIVACY_CONTACT_EMAIL: PRIVACY,
    PRIVACY_CONTACT_NAME: 'the Grievance Officer',
    ...env,
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  const a = await buildApp(parsed.config, {
    keys: createKeyfileKeyProvider({ masterKey: randomBytes(32) }),
    mailer: createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}` }),
    underPressure: false,
    authLimits: ROOMY,
    ...deps,
  });
  apps.push(a);
  return a;
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_account');
  ({ urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false }));
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  chainer = createDb(urls.fr_app, { max: 2, applicationName: 'fr-api-test-chain' });
  sink = await startSmtpSink();
  app = await start();
});

afterAll(async () => {
  for (const a of apps) await a.close();
  await chainer?.close();
  await owner?.end();
  await sink?.close();
});

class Jar {
  readonly cookies = new Map<string, string>();
  take(res: LightMyRequestResponse): void {
    for (const c of res.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() <= Date.now()) || c.maxAge === 0) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
  }
  get header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get session(): string | undefined {
    return this.cookies.get('__Host-fr_sess');
  }
}

async function call(jar: Jar | null, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown, target = app, headers: Record<string, string> = BROWSER) {
  const res = await target.inject({
    method,
    url,
    headers: { ...(method === 'GET' ? {} : headers), ...(jar?.header ? { cookie: jar.header } : {}) },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  jar?.take(res);
  return res;
}

const qpDecode = (s: string) => s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));

/** The newest message to `to` whose subject matches, waiting for the background send. */
async function mailTo(to: string, subject: RegExp, since: number): Promise<{ subject: string; text: string }> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const hit = sink.messages
      .slice(since)
      .filter((m) => m.recipients.includes(to.toLowerCase()) && subject.test(m.subject))
      .at(-1);
    if (hit) return { subject: hit.subject, text: qpDecode(hit.raw) };
    if (Date.now() > deadline) throw new Error(`no mail ${subject} to ${to}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const newEmail = () => `acct-${randomUUID().slice(0, 8)}@example.test`;

/** `PATCH /v1/me` as the builder sends it. */
function patchMe(jar: Jar, body: unknown) {
  return app.inject({ method: 'PATCH', url: '/v1/me', headers: { ...BROWSER, cookie: jar.header }, payload: body as Record<string, unknown> });
}

async function signedUp(email = newEmail(), target = app): Promise<{ jar: Jar; email: string; userId: string }> {
  const since = sink.messages.length;
  const jar = new Jar();
  expect((await call(jar, 'POST', '/v1/auth/signup', { email, password: PASSWORD, name: 'Asha', noticeVersion: NOTICE_VERSION }, target)).statusCode).toBe(202);
  const mail = await mailTo(email, /Confirm your email/, since);
  const token = /\/auth\/verify#token=([A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
  const verified = await call(jar, 'POST', '/v1/auth/verify-email', { token }, target);
  expect(verified.statusCode).toBe(200);
  return { jar, email, userId: verified.json<{ user: { id: string } }>().user.id };
}

async function events(userId: string): Promise<Array<{ action: string; outcome: string; reason?: string; metadata?: Record<string, unknown> }>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where event->>'actorId' = $1 order by id`, [userId]);
  return rows.map(({ event: e }) => ({
    action: String(e.action),
    outcome: String(e.outcome),
    ...(e.reason ? { reason: String(e.reason) } : {}),
    ...(e.metadata ? { metadata: e.metadata as Record<string, unknown> } : {}),
  }));
}

async function org(members: Array<[string, string]>): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const name = `Org ${id.slice(0, 6)}`;
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $3)', [id, `org-${id.slice(0, 8)}`, name]);
  for (const [i, [userId, role]] of members.entries()) {
    await owner.query(`insert into memberships (org_id, user_id, role, created_at) values ($1, $2, $3, now() - make_interval(days => $4))`, [id, userId, role, 10 - i]);
  }
  return { id, name };
}

async function form(orgId: string, ownerId: string): Promise<string> {
  const id = randomUUID();
  await owner.query('insert into forms (id, org_id, team_id, owner_user_id, title, updated_by) values ($1, $2, $3, $4, $5, $4)', [id, orgId, randomUUID(), ownerId, 'Intake']);
  return id;
}

describe('the platform privacy notice (CMP-21)', () => {
  it('is served with its version, hash and the configured privacy contact', async () => {
    const res = await call(null, 'GET', '/v1/privacy/notice');
    expect(res.statusCode).toBe(200);
    const n = res.json<{ version: string; hash: string; fiduciary: string; contact: { email: string; name: string }; sections: Array<{ paragraphs: string[] }> }>();
    expect(n).toMatchObject({ version: NOTICE_VERSION, locale: 'en-IN', fiduciary: 'fORM- Test Operator', contact: { email: PRIVACY, name: 'the Grievance Officer' } });
    expect(n.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(n.sections)).toContain(`Write to the Grievance Officer at ${PRIVACY}`);
  });

  it('records the version shown at sign-up and refuses a stale one', async () => {
    const stale = newEmail();
    const refused = await call(new Jar(), 'POST', '/v1/auth/signup', { email: stale, password: PASSWORD, noticeVersion: '2020-01-01' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'NOTICE_OUTDATED' });
    expect((await owner.query('select 1 from users where email = $1', [stale])).rowCount).toBe(0);
    const missing = await call(new Jar(), 'POST', '/v1/auth/signup', { email: stale, password: PASSWORD });
    expect(missing.statusCode).toBe(400);

    const { jar, userId } = await signedUp();
    const { hash } = (await call(null, 'GET', '/v1/privacy/notice')).json<{ hash: string }>();
    const { rows } = await owner.query(`select notice_version, encode(notice_hash, 'hex') as hash, locale, context from user_notice_acks where user_id = $1`, [userId]);
    expect(rows).toEqual([{ notice_version: NOTICE_VERSION, hash, locale: 'en-IN', context: 'signup' }]);
    expect((await call(jar, 'GET', '/v1/me')).json()).toMatchObject({ notice: { version: NOTICE_VERSION, acknowledgedVersion: NOTICE_VERSION, current: true } });
    expect(await events(userId)).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'account.notice_acknowledged', outcome: 'success', metadata: { version: NOTICE_VERSION, hash, context: 'signup' } })]));
  });

  it('asks for the new text in settings once it changes, and records it there', async () => {
    const { jar, userId } = await signedUp();
    const changed = await start({ PRIVACY_CONTACT_EMAIL: 'dpo@form.test' });
    expect((await call(jar, 'GET', '/v1/me', undefined, changed)).json()).toMatchObject({ notice: { acknowledgedVersion: NOTICE_VERSION, current: false } });
    const old = (await call(null, 'GET', '/v1/privacy/notice')).json<{ version: string; hash: string }>();
    const next = (await call(null, 'GET', '/v1/privacy/notice', undefined, changed)).json<{ version: string; hash: string }>();
    expect(next.hash).not.toBe(old.hash);
    const outdated = await call(jar, 'POST', '/v1/me/notice', { version: old.version, hash: old.hash }, changed);
    expect(outdated.json()).toMatchObject({ code: 'NOTICE_OUTDATED' });
    expect((await call(jar, 'POST', '/v1/me/notice', { version: next.version, hash: next.hash }, changed)).json()).toEqual({ version: NOTICE_VERSION, acknowledged: true });
    expect((await call(jar, 'POST', '/v1/me/notice', { version: next.version, hash: next.hash }, changed)).json()).toEqual({ version: NOTICE_VERSION, acknowledged: false });
    expect((await call(jar, 'GET', '/v1/me', undefined, changed)).json()).toMatchObject({ notice: { current: true } });
    const { rows } = await owner.query(`select context from user_notice_acks where user_id = $1 order by acknowledged_at`, [userId]);
    expect(rows.map((r) => r.context)).toEqual(['signup', 'settings']);
  });
});

describe('PATCH /v1/me', () => {
  it('corrects the name, and only the caller’s', async () => {
    const { jar, userId } = await signedUp();
    const res = await patchMe(jar, { name: '  Asha Rao ' });
    expect(res.json()).toMatchObject({ user: { id: userId, name: 'Asha Rao' } });
    expect((await call(jar, 'GET', '/v1/me')).json()).toMatchObject({ user: { name: 'Asha Rao' } });
    expect((await patchMe(jar, { name: null })).json()).toMatchObject({ user: { name: null } });
    expect((await patchMe(jar, { name: 'x'.repeat(201) })).statusCode).toBe(400);
    expect(await events(userId)).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'account.profile_updated', metadata: { changed: ['name'] } })]));
  });
});

describe('POST /v1/me/export', () => {
  it('downloads everything held about the account, and nothing secret', async () => {
    const { jar, email, userId } = await signedUp();
    const other = await signedUp();
    const o = await org([
      [other.userId, 'owner'],
      [userId, 'editor'],
    ]);
    await form(o.id, userId);
    expect((await call(jar, 'POST', '/v1/me/grievances', { category: 'information', message: 'What do you keep about me?' })).statusCode).toBe(201);
    await withTenant(chainer.db, { orgId: PLATFORM_ORG_KEY, actor: 'system', requestId: 'chain' }, (tx) => chainPending(tx, PLATFORM_ORG_KEY));

    const res = await call(jar, 'POST', '/v1/me/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="form-account-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    const data = res.json<Record<string, unknown>>();
    expect(data).toMatchObject({
      format: 'fr.account-export@1',
      user: { id: userId, email, name: 'Asha', status: 'active', hasPassword: true, totpEnabledAt: null, recoveryCodesLeft: 0 },
      memberships: [{ orgId: o.id, orgName: o.name, role: 'editor', status: 'active', formsOwned: 1 }],
      notices: [{ version: NOTICE_VERSION, context: 'signup' }],
      requests: [{ category: 'information', message: 'What do you keep about me?', status: 'open' }],
      linkedAccounts: [],
    });
    expect(data.sessions).toEqual([expect.objectContaining({ mfaLevel: 'link', revokedAt: null })]);
    const actions = (data.activity as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.signup', 'auth.email_verified', 'auth.login', 'account.notice_acknowledged', 'account.grievance_filed']));
    // Another user's events, credentials and keyed hashes stay out.
    const text = res.body;
    for (const leaked of [other.userId, other.email, 'argon2', 'token_hash', 'ip_hash', 'actorIpHash']) expect(text).not.toContain(leaked);
    expect(await events(userId)).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'account.exported', outcome: 'success' })]));
  });

  it('is refused cross-site and without a session', async () => {
    const { jar } = await signedUp();
    const res = await call(jar, 'POST', '/v1/me/export', undefined, app, { 'sec-fetch-site': 'cross-site', 'x-fr-client': 'builder' });
    expect(res.json()).toMatchObject({ code: 'CSRF_REJECTED' });
    expect((await call(null, 'POST', '/v1/me/export')).statusCode).toBe(401);
  });
});

describe('POST /v1/me/delete', () => {
  it('is blocked for an org’s only owner, then keeps the org’s data with the org once another owner exists', async () => {
    const leaver = await signedUp();
    const colleague = await signedUp();
    const o = await org([
      [leaver.userId, 'owner'],
      [colleague.userId, 'editor'],
    ]);
    const formId = await form(o.id, leaver.userId);

    const plan = await call(leaver.jar, 'GET', '/v1/me/deletion');
    expect(plan.json()).toEqual({
      status: 'blocked',
      orgs: [{ orgId: o.id, slug: expect.any(String), name: o.name, role: 'owner', formsOwned: 1, formsTo: null, blocker: 'sole_owner' }],
      recentSignIn: true,
      signInWithinMinutes: 15,
    });
    const mismatch = await call(leaver.jar, 'POST', '/v1/me/delete', { confirmEmail: colleague.email });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json()).toMatchObject({ code: 'CONFIRMATION_MISMATCH' });
    const blocked = await call(leaver.jar, 'POST', '/v1/me/delete', { confirmEmail: leaver.email.toUpperCase() });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'ACCOUNT_DELETION_BLOCKED', detail: expect.stringContaining(o.name) });
    expect((await call(leaver.jar, 'GET', '/v1/me')).statusCode).toBe(200);

    await owner.query(`update memberships set role = 'owner' where org_id = $1 and user_id = $2`, [o.id, colleague.userId]);
    expect((await call(leaver.jar, 'GET', '/v1/me/deletion')).json()).toMatchObject({ status: 'ready', orgs: [{ formsTo: colleague.userId, blocker: null }] });
    const since = sink.messages.length;
    const cookie = leaver.jar.session!;
    const done = await call(leaver.jar, 'POST', '/v1/me/delete', { confirmEmail: leaver.email });
    expect(done.statusCode).toBe(200);
    const body = done.json<{ status: string; orgsLeft: number; formsReassigned: number; backupsExpireBy: string }>();
    expect(body).toMatchObject({ status: 'deleted', orgsLeft: 1, formsReassigned: 1 });
    expect(new Date(body.backupsExpireBy).getTime()).toBeGreaterThan(Date.now() + 34 * 86_400_000);
    expect(leaver.jar.session).toBeUndefined();

    // Signed out everywhere, and the account is gone; the org keeps the form under its other owner.
    expect((await app.inject({ url: '/v1/me', headers: { cookie: `__Host-fr_sess=${cookie}` } })).statusCode).toBe(401);
    expect((await call(new Jar(), 'POST', '/v1/auth/login', { email: leaver.email, password: PASSWORD })).json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect((await owner.query('select owner_user_id from forms where id = $1', [formId])).rows).toEqual([{ owner_user_id: colleague.userId }]);
    expect((await owner.query('select user_id from memberships where org_id = $1', [o.id])).rows).toEqual([{ user_id: colleague.userId }]);
    const mail = await mailTo(leaver.email, /Your account was deleted/, since);
    expect(mail.text).toContain(PRIVACY);
    expect(await events(leaver.userId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'account.deleted', outcome: 'denied', reason: 'confirmation_mismatch' }),
        expect.objectContaining({ action: 'account.deleted', outcome: 'denied', reason: 'blocked' }),
        expect.objectContaining({ action: 'account.deleted', outcome: 'success', metadata: expect.objectContaining({ orgsLeft: 1, formsReassigned: 1, sessionsEnded: 1 }) }),
      ]),
    );

    // The address can open a new, unrelated account.
    const again = await signedUp(leaver.email);
    expect(again.userId).not.toBe(leaver.userId);
    expect((await call(again.jar, 'GET', '/v1/me')).json()).toMatchObject({ orgs: [] });
  });

  it('deletes an account without orgs, ending every session', async () => {
    const { jar, email, userId } = await signedUp();
    const elsewhere = new Jar();
    await call(elsewhere, 'POST', '/v1/auth/login', { email, password: PASSWORD });
    expect(elsewhere.session).toBeDefined();
    expect((await call(jar, 'POST', '/v1/me/delete', { confirmEmail: email })).json()).toMatchObject({ status: 'deleted', orgsLeft: 0, formsReassigned: 0 });
    expect((await call(elsewhere, 'GET', '/v1/me')).statusCode).toBe(401);
    const { rows } = await owner.query(`select status, email, name from users where id = $1`, [userId]);
    expect(rows).toEqual([{ status: 'deleted', email: `deleted-${userId}@deleted.invalid`, name: null }]);
  });

  it('needs a sign-in from the last 15 minutes', async () => {
    const { jar, email } = await signedUp();
    const later = await start({}, { now: () => new Date(Date.now() + 16 * 60_000) });
    expect((await call(jar, 'GET', '/v1/me/deletion', undefined, later)).json()).toMatchObject({ recentSignIn: false });
    const res = await call(jar, 'POST', '/v1/me/delete', { confirmEmail: email }, later);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'REAUTH_REQUIRED' });
    expect((await call(jar, 'GET', '/v1/me')).statusCode).toBe(200);
  });
});

describe('privacy requests to the platform', () => {
  it('files a request with a reference and a 90-day due date, mails a receipt and the privacy contact, and lists it', async () => {
    const { jar, email, userId } = await signedUp();
    const since = sink.messages.length;
    const res = await call(jar, 'POST', '/v1/me/grievances', { category: 'correction', message: '  Please fix the spelling of my name.  ' });
    expect(res.statusCode).toBe(201);
    const g = res.json<{ reference: string; dueAt: string; createdAt: string }>();
    expect(g).toMatchObject({ reference: expect.stringMatching(/^GRV-[A-Z2-7]{8}$/), category: 'correction', message: 'Please fix the spelling of my name.', status: 'open', closedAt: null });
    expect(new Date(g.dueAt).getTime() - new Date(g.createdAt).getTime()).toBe(90 * 86_400_000);
    expect((await mailTo(email, new RegExp(g.reference), since)).text).toContain(PRIVACY);
    const copy = await mailTo(PRIVACY, new RegExp(`${g.reference} \\(correction\\)`), since);
    expect(copy.text).toContain('Please fix the spelling of my name.');
    expect(copy.text).toContain(email);
    expect((await call(jar, 'GET', '/v1/me/grievances')).json()).toEqual({ items: [expect.objectContaining({ reference: g.reference })] });
    const filed = (await events(userId)).find((e) => e.action === 'account.grievance_filed');
    expect(filed).toMatchObject({ outcome: 'success', metadata: { reference: g.reference, category: 'correction' } });
    expect(JSON.stringify(filed)).not.toContain('spelling');
  });

  it('takes ten a day per user, and refuses empty or unknown ones', async () => {
    const { jar } = await signedUp();
    expect((await call(jar, 'POST', '/v1/me/grievances', { category: 'complaint', message: '   ' })).statusCode).toBe(400);
    expect((await call(jar, 'POST', '/v1/me/grievances', { category: 'refund', message: 'x' })).statusCode).toBe(400);
    for (let i = 0; i < 10; i++) expect((await call(jar, 'POST', '/v1/me/grievances', { category: 'other', message: `n${i}` })).statusCode).toBe(201);
    const limited = await call(jar, 'POST', '/v1/me/grievances', { category: 'other', message: 'one more' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ detail: string }>().detail).toContain(PRIVACY);
  });

  it('closes open requests without their message when the account is deleted', async () => {
    const { jar, email, userId } = await signedUp();
    await call(jar, 'POST', '/v1/me/grievances', { category: 'erasure', message: 'Delete everything.' });
    await call(jar, 'POST', '/v1/me/delete', { confirmEmail: email });
    const { rows } = await owner.query(`select category, message, status from user_grievances where user_id = $1`, [userId]);
    expect(rows).toEqual([{ category: 'erasure', message: null, status: 'closed' }]);
  });
});
