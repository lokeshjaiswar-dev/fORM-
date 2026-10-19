import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createKeyfileKeyProvider, createSmtpMailer } from '@form/adapters';
import { chainPending, createDb, PLATFORM_ORG_KEY, provision, withTenant, type DbHandle } from '@form/db';
import { createTestDatabase, startMockOidcProvider, startSmtpSink, type MockOidcProvider, type SmtpSink } from '@form/testkit';
import { buildApp, type AppDeps } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { base32Decode } from '../src/modules/auth/crypto.ts';
import { hotp, totpStep } from '../src/modules/auth/totp.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

const BUILDER = 'https://app.form.test';
const API = 'https://api.form.test';
const PASSWORD = 'violet-anchor-teapot-91';
/** What the builder's fetch sends on every unsafe request (ADR-0008). */
const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;

/** Every request here comes from 127.0.0.1: the shared app gets room; the throttling cases build their own. */
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
let google: MockOidcProvider;
let app: FastifyInstance;
const apps: FastifyInstance[] = [];
const keys = createKeyfileKeyProvider({ masterKey: randomBytes(32) });

function config(env: Record<string, string> = {}) {
  const parsed = parseConfig({
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'saas',
    DATABASE_URL: urls.fr_app,
    LOG_LEVEL: 'silent',
    PUBLIC_BUILDER_URL: BUILDER,
    PUBLIC_API_URL: API,
    AUTH_SECRET: randomBytes(32).toString('base64url'),
    PASSWORD_BREACH_CHECK: 'off',
    OIDC_GOOGLE_CLIENT_ID: 'fr-google',
    OIDC_GOOGLE_CLIENT_SECRET: 'google-test-secret',
    OIDC_GOOGLE_ISSUER: google.issuer,
    ...env,
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.config;
}

async function start(env: Record<string, string> = {}, deps: AppDeps = {}): Promise<FastifyInstance> {
  const a = await buildApp(config(env), { keys, mailer: createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}` }), underPressure: false, ...deps });
  apps.push(a);
  return a;
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_auth');
  ({ urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false }));
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  chainer = createDb(urls.fr_app, { max: 2, applicationName: 'fr-api-test-chain' });
  sink = await startSmtpSink();
  google = await startMockOidcProvider({ clients: [{ clientId: 'fr-google', clientSecret: 'google-test-secret', redirectUris: [`${API}/v1/auth/oauth/google/callback`] }] });
  app = await start({}, { authLimits: ROOMY });
});

afterAll(async () => {
  for (const a of apps) await a.close();
  await chainer?.close();
  await owner?.end();
  await sink?.close();
  await google?.close();
});

/** A browser's cookie jar for the API, as far as these tests need one. */
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

async function call(jar: Jar | null, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}, target = app) {
  const res = await target.inject({
    method,
    url,
    headers: { ...(method === 'GET' ? {} : BROWSER), ...(jar?.header ? { cookie: jar.header } : {}), ...headers },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  jar?.take(res);
  return res;
}

const qpDecode = (s: string) => s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));

/** The newest message to `to` with a token link, waiting for the background send. */
async function mailTo(to: string, path: string, since = 0): Promise<{ token: string; subject: string }> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const hits = sink.messages.slice(since).filter((m) => m.recipients.includes(to.toLowerCase()));
    for (const m of hits.reverse()) {
      const token = new RegExp(`${path.replace(/\//g, '\\/')}#token=([A-Za-z0-9_-]{43})`).exec(qpDecode(m.raw))?.[1];
      if (token) return { token, subject: m.subject };
    }
    if (Date.now() > deadline) throw new Error(`no ${path} mail to ${to}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function subjectsTo(to: string, since: number): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 300));
  return sink.messages.slice(since).filter((m) => m.recipients.includes(to)).map((m) => m.subject);
}

const newEmail = () => `user-${randomUUID().slice(0, 8)}@example.test`;

async function pending(where: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where ${where} order by id`, params);
  return rows.map((r) => r.event);
}

async function events(userId: string): Promise<Array<{ action: string; outcome: string; reason?: string }>> {
  return (await pending(`event->>'actorId' = $1 or event->>'resourceId' = $1`, [userId])).map((e) => ({
    action: String(e.action),
    outcome: String(e.outcome),
    ...(e.reason ? { reason: String(e.reason) } : {}),
  }));
}

/** Sign-up and verification: a signed-in jar and the user's id. */
async function signedUp(email = newEmail()): Promise<{ jar: Jar; email: string; userId: string }> {
  const since = sink.messages.length;
  const jar = new Jar();
  expect((await call(jar, 'POST', '/v1/auth/signup', { email, password: PASSWORD, name: 'Asha' })).statusCode).toBe(202);
  const { token } = await mailTo(email, '/auth/verify', since);
  const verified = await call(jar, 'POST', '/v1/auth/verify-email', { token });
  expect(verified.json()).toMatchObject({ status: 'signed_in', user: { email, emailVerified: true, totpEnabled: false } });
  return { jar, email, userId: verified.json<{ user: { id: string } }>().user.id };
}

async function codeFor(secret: string, offset = 0): Promise<string> {
  return hotp(base32Decode(secret), totpStep(new Date()) + offset);
}

/** A six-digit code that no step in the accepted window (±1) produces. */
async function wrongCode(secret: string): Promise<string> {
  const valid = await Promise.all([-1, 0, 1].map((o) => codeFor(secret, o)));
  return ['123456', '234567', '345678', '456789'].find((c) => !valid.includes(c)) as string;
}

/** TOTP on: returns the secret, the recovery codes, and the jar's rotated cookie. */
async function enrol(jar: Jar): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await call(jar, 'POST', '/v1/auth/mfa/totp/setup');
  expect(setup.statusCode).toBe(200);
  const { secret, otpauthUri } = setup.json<{ secret: string; otpauthUri: string }>();
  expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/fORM-%3A/);
  const verify = await call(jar, 'POST', '/v1/auth/mfa/totp/verify', { code: await codeFor(secret) });
  expect(verify.statusCode).toBe(200);
  return { secret, recoveryCodes: verify.json<{ recoveryCodes: string[] }>().recoveryCodes };
}

describe('sign-up → verify → 2FA enrol → sign out → TOTP sign-in → recovery-code sign-in', () => {
  it('runs the acceptance flow end to end against Postgres, SMTP and the KMS', async () => {
    const { jar, email, userId } = await signedUp();
    const me = await call(jar, 'GET', '/v1/me');
    expect(me.json()).toMatchObject({ user: { id: userId, email }, session: { mfaLevel: 'link' }, orgs: [] });
    expect(me.headers['cache-control']).toBe('no-store');

    const beforeEnrol = jar.session!;
    const { secret, recoveryCodes } = await enrol(jar);
    expect(recoveryCodes).toHaveLength(10);
    // Rotation on the privilege change: a new token at the new level; the old one is dead.
    expect(jar.session).not.toBe(beforeEnrol);
    expect((await call(jar, 'GET', '/v1/me')).json()).toMatchObject({ user: { totpEnabled: true }, session: { mfaLevel: 'link+totp' } });
    const stale = await app.inject({ url: '/v1/me', headers: { cookie: `__Host-fr_sess=${beforeEnrol}` } });
    expect(stale.statusCode).toBe(401);

    expect((await call(jar, 'POST', '/v1/auth/logout')).statusCode).toBe(204);
    expect(jar.session).toBeUndefined();

    // TOTP sign-in: the password alone yields a ticket, not a session.
    const login = await call(jar, 'POST', '/v1/auth/login', { email, password: PASSWORD });
    expect(login.json()).toMatchObject({ status: 'mfa_required', methods: ['totp', 'recovery'] });
    expect(jar.session).toBeUndefined();
    const { ticket } = login.json<{ ticket: string }>();
    const wrong = await call(jar, 'POST', '/v1/auth/mfa/totp', { ticket, code: '000000' === (await codeFor(secret, 1)) ? '111111' : '000000' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: 'INVALID_CODE' });
    // The enrolment used the current step; the next one is within the allowed drift.
    const totp = await call(jar, 'POST', '/v1/auth/mfa/totp', { ticket, code: await codeFor(secret, 1) });
    expect(totp.json()).toMatchObject({ status: 'signed_in', user: { id: userId, totpEnabled: true } });
    expect((await call(jar, 'GET', '/v1/me')).json()).toMatchObject({ session: { mfaLevel: 'pwd+totp' } });
    // The ticket and the code are both single-use.
    expect((await call(null, 'POST', '/v1/auth/mfa/totp', { ticket, code: await codeFor(secret, 1) })).statusCode).toBe(400);

    expect((await call(jar, 'POST', '/v1/auth/logout')).statusCode).toBe(204);

    // Recovery-code sign-in, when the authenticator is lost.
    const again = await call(jar, 'POST', '/v1/auth/login', { email, password: PASSWORD });
    const recovery = await call(jar, 'POST', '/v1/auth/mfa/recovery', { ticket: again.json<{ ticket: string }>().ticket, code: recoveryCodes[0]!.toLowerCase() });
    expect(recovery.json()).toMatchObject({ status: 'signed_in', recoveryCodesLeft: 9 });
    expect((await call(jar, 'GET', '/v1/me')).json()).toMatchObject({ session: { mfaLevel: 'pwd+recovery' } });
    await call(jar, 'POST', '/v1/auth/logout');
    const third = await call(jar, 'POST', '/v1/auth/login', { email, password: PASSWORD });
    const reused = await call(jar, 'POST', '/v1/auth/mfa/recovery', { ticket: third.json<{ ticket: string }>().ticket, code: recoveryCodes[0]! });
    expect(reused.statusCode).toBe(401);

    expect(await events(userId)).toEqual(
      expect.arrayContaining([
        { action: 'auth.signup', outcome: 'success' },
        { action: 'auth.email_verified', outcome: 'success' },
        { action: 'auth.login', outcome: 'success' },
        { action: 'auth.totp_setup', outcome: 'success' },
        { action: 'auth.session_rotated', outcome: 'success' },
        { action: 'auth.totp_enabled', outcome: 'success' },
        { action: 'auth.logout', outcome: 'success' },
        { action: 'auth.mfa_challenged', outcome: 'success' },
        { action: 'auth.login', outcome: 'denied', reason: 'bad_totp' },
        { action: 'auth.login', outcome: 'denied', reason: 'bad_recovery_code' },
      ]),
    );

    // The records land in the platform chain's audit_log once audit.chain runs, never carrying a secret.
    await withTenant(chainer.db, { orgId: PLATFORM_ORG_KEY, actor: 'system', requestId: 'chain' }, (tx) => chainPending(tx, PLATFORM_ORG_KEY));
    const { rows } = await owner.query<{ action: string; actor_ip_hash: Buffer | null; metadata: unknown }>(
      `select action, actor_ip_hash, metadata from audit_log where org_id = $1 and actor_id = $2 order by seq`,
      [PLATFORM_ORG_KEY, userId],
    );
    expect(rows.map((r) => r.action)).toContain('auth.totp_enabled');
    expect(rows.every((r) => r.actor_ip_hash?.length === 16)).toBe(true);
    const all = JSON.stringify(rows);
    for (const leaked of [PASSWORD, secret, recoveryCodes[1]!, ticket, '127.0.0.1']) expect(all).not.toContain(leaked);
  });
});

describe('sessions', () => {
  it('session fixation: a token planted before sign-in never becomes the signed-in session', async () => {
    const victim = await signedUp();
    await call(victim.jar, 'POST', '/v1/auth/logout');
    const attacker = await signedUp();
    const planted = attacker.jar.session!;

    // The attacker's own (valid) token, and a made-up one, are planted in the victim's browser.
    for (const token of [planted, randomBytes(32).toString('base64url')]) {
      const jar = new Jar();
      jar.cookies.set('__Host-fr_sess', token);
      const res = await call(jar, 'POST', '/v1/auth/login', { email: victim.email, password: PASSWORD });
      expect(res.json()).toMatchObject({ status: 'signed_in', user: { id: victim.userId } });
      expect(jar.session).toBeDefined();
      expect(jar.session).not.toBe(token);
      expect((await call(jar, 'GET', '/v1/me')).json()).toMatchObject({ user: { id: victim.userId } });
    }
    // The planted token never authenticates as the victim.
    const asPlanted = await app.inject({ url: '/v1/me', headers: { cookie: `__Host-fr_sess=${planted}` } });
    expect(asPlanted.json()).toMatchObject({ user: { id: attacker.userId } });
  });

  it('signing in again in the same browser revokes the session it presented', async () => {
    const { jar, email } = await signedUp();
    const first = jar.session!;
    await call(jar, 'POST', '/v1/auth/login', { email, password: PASSWORD });
    expect(jar.session).not.toBe(first);
    expect((await app.inject({ url: '/v1/me', headers: { cookie: `__Host-fr_sess=${first}` } })).statusCode).toBe(401);
  });

  it('sets a __Host- cookie: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain', async () => {
    const email = newEmail();
    const since = sink.messages.length;
    const jar = new Jar();
    const signup = await call(jar, 'POST', '/v1/auth/signup', { email, password: PASSWORD });
    expect(signup.cookies.find((c) => c.name === '__Host-fr_signup')).toMatchObject({ path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
    const res = await call(jar, 'POST', '/v1/auth/verify-email', { token: (await mailTo(email, '/auth/verify', since)).token });
    const cookie = res.cookies.find((c) => c.name === '__Host-fr_sess')!;
    expect(cookie).toMatchObject({ path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
    expect(cookie.domain).toBeUndefined();
    expect(cookie.expires!.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    expect(jar.cookies.has('__Host-fr_signup')).toBe(false);
  });

  it('rejects expired, revoked and malformed cookies, clears them and audits the rejection', async () => {
    const { jar, userId } = await signedUp();
    await owner.query(`update sessions set idle_expires_at = now() - interval '1 second' where user_id = $1`, [userId]);
    const res = await call(jar, 'GET', '/v1/me');
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === '__Host-fr_sess')?.value).toBe('');
    expect((await events(userId)).at(-1)).toEqual({ action: 'auth.session_rejected', outcome: 'denied', reason: 'expired' });
    const malformed = await app.inject({ url: '/v1/me', headers: { cookie: '__Host-fr_sess=x' } });
    expect(malformed.statusCode).toBe(401);
  });

  it('lists the user’s sessions and revokes one, and another user’s id looks unknown', async () => {
    const a = await signedUp();
    const other = new Jar();
    await call(other, 'POST', '/v1/auth/login', { email: a.email, password: PASSWORD });
    const list = (await call(a.jar, 'GET', '/v1/me/sessions')).json<{ items: Array<{ id: string; current: boolean }> }>().items;
    expect(list).toHaveLength(2);
    const notCurrent = list.find((s) => !s.current)!;
    expect((await call(a.jar, 'DELETE', `/v1/me/sessions/${notCurrent.id}`)).statusCode).toBe(204);
    expect((await call(other, 'GET', '/v1/me')).statusCode).toBe(401);
    const b = await signedUp();
    const current = list.find((s) => s.current)!;
    expect((await call(b.jar, 'DELETE', `/v1/me/sessions/${current.id}`)).statusCode).toBe(404);
    expect((await call(a.jar, 'GET', '/v1/me')).statusCode).toBe(200);
  });

  it('authenticates org routes with the session and X-FR-Org', async () => {
    const { jar, userId } = await signedUp();
    const orgId = randomUUID();
    await owner.query(`insert into orgs (id, slug, name) values ($1, $2, 'Session org')`, [orgId, `s-${orgId.slice(0, 8)}`]);
    await owner.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')`, [orgId, userId]);
    const res = await call(jar, 'GET', '/v1/forms', undefined, { 'x-fr-org': orgId });
    expect(res.statusCode).toBe(200);
    expect((await call(jar, 'GET', '/v1/me')).json()).toMatchObject({ orgs: [{ id: orgId, role: 'viewer' }] });
  });
});

describe('CSRF (ADR-0008)', () => {
  it('refuses a cross-site POST without the header, keeps the session and audits the refusal', async () => {
    const { jar, userId } = await signedUp();
    const forged = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: jar.header, 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } });
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toMatchObject({ code: 'CSRF_REJECTED' });
    const withHeader = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: jar.header, 'x-fr-client': 'builder', 'sec-fetch-site': 'cross-site' } });
    expect(withHeader.statusCode).toBe(403);
    const noMetadata = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: jar.header, 'x-fr-client': 'builder' } });
    expect(noMetadata.statusCode).toBe(403);
    expect((await call(jar, 'GET', '/v1/me')).json()).toMatchObject({ user: { id: userId } });
    const refusals = await pending(`event->>'requestId' = $1`, [forged.headers['x-request-id']]);
    expect(refusals).toEqual([expect.objectContaining({ action: 'request.authorize', outcome: 'denied', reason: 'csrf_missing_client_header' })]);
  });

  it('accepts same-site requests from the configured builder origin only (SaaS sibling hosts)', async () => {
    const { jar } = await signedUp();
    const sibling = { cookie: jar.header, 'x-fr-client': 'builder', 'sec-fetch-site': 'same-site' };
    expect((await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/setup', headers: { ...sibling, origin: 'https://forms.form.test' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/setup', headers: { ...sibling, origin: BUILDER } })).statusCode).toBe(200);
  });

  it('counts refusals against the IP, so cross-site requests and junk cookies cannot flood the audit chain', async () => {
    const limited = await start({}, { authLimits: { auth_any: { max: 3, windowSeconds: 60 } } });
    const forged = [
      { url: '/v1/auth/login', payload: { email: 'a@b.test', password: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } },
      { url: '/v1/auth/login', payload: { email: 'a@b.test', password: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } },
      { url: `/v1/me/sessions/${randomUUID()}`, method: 'DELETE' as const, headers: { cookie: '__Host-fr_sess=junk' } },
      { url: '/v1/auth/logout', headers: { cookie: '__Host-fr_sess=junk', 'x-fr-client': 'builder', 'sec-fetch-site': 'cross-site' } },
      { url: '/v1/auth/login', payload: { email: 'a@b.test', password: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } },
    ];
    const codes = [];
    for (const [i, f] of forged.entries()) {
      const res = await limited.inject({ method: f.method ?? 'POST', url: f.url, headers: { ...f.headers, 'x-request-id': `csrf-flood-${i}` }, ...(f.payload ? { payload: f.payload } : {}) });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([403, 403, 403, 429, 429]);
    const refused = await pending(`event->>'action' = 'request.authorize' and event->>'requestId' like 'csrf-flood-%'`, []);
    expect(refused).toHaveLength(3);
    const throttled = await pending(`event->>'action' = 'auth.throttled' and event->>'requestId' like 'csrf-flood-%'`, []);
    expect(throttled).toEqual([expect.objectContaining({ reason: 'auth_any' })]);
  });

  it('guards credential requests without a cookie too (login CSRF)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'a@b.test', password: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('password and email-link flows', () => {
  it('answers the same for an unknown address and a wrong password', async () => {
    const { email } = await signedUp();
    const unknown = await call(null, 'POST', '/v1/auth/login', { email: newEmail(), password: PASSWORD });
    const wrong = await call(null, 'POST', '/v1/auth/login', { email, password: 'not-the-password' });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    const strip = (r: LightMyRequestResponse) => ({ ...r.json<Record<string, unknown>>(), instance: undefined, requestId: undefined });
    expect(strip(unknown)).toEqual(strip(wrong));
  });

  it('does not reveal a taken address at sign-up; the owner gets a notice instead', async () => {
    const { email } = await signedUp();
    const since = sink.messages.length;
    const res = await call(null, 'POST', '/v1/auth/signup', { email: email.toUpperCase(), password: 'another-strong-passphrase' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'verification_sent' });
    expect(await subjectsTo(email, since)).toEqual(['You already have an account']);
  });

  it('refuses weak passwords with the reason', async () => {
    const res = await call(null, 'POST', '/v1/auth/signup', { email: newEmail(), password: 'password123' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'WEAK_PASSWORD', detail: expect.stringMatching(/too common/) });
  });

  it('asks an unverified account to verify first, with a fresh link', async () => {
    const email = newEmail();
    await call(null, 'POST', '/v1/auth/signup', { email, password: PASSWORD });
    const since = sink.messages.length;
    const res = await call(null, 'POST', '/v1/auth/login', { email, password: PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    expect((await mailTo(email, '/auth/verify', since)).subject).toBe('Confirm your email address');
  });

  it('needs the password to verify a never-verified address in another browser, so a pre-registered account is not handed to its squatter', async () => {
    const victim = newEmail();
    const since = sink.messages.length;
    // Someone registers the victim's address with their own password; the victim gets the verification mail.
    const squatter = new Jar();
    await call(squatter, 'POST', '/v1/auth/signup', { email: victim, password: 'squatters-own-passphrase' });
    const { token } = await mailTo(victim, '/auth/verify', since);
    const victimJar = new Jar();
    expect((await call(victimJar, 'POST', '/v1/auth/link', { token, purpose: 'verify_email' })).json()).toEqual({ email: victim, passwordRequired: true });
    const bare = await call(victimJar, 'POST', '/v1/auth/verify-email', { token });
    expect(bare.statusCode).toBe(401);
    expect(bare.json()).toMatchObject({ code: 'PASSWORD_REQUIRED' });
    expect(victimJar.session).toBeUndefined();
    expect((await call(victimJar, 'POST', '/v1/auth/verify-email', { token, password: PASSWORD })).json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    // The victim takes the account over with a reset instead; the squatter's password is gone.
    const resetSince = sink.messages.length;
    await call(null, 'POST', '/v1/auth/password/forgot', { email: victim });
    const reset = await mailTo(victim, '/auth/reset', resetSince);
    expect((await call(null, 'POST', '/v1/auth/password/reset', { token: reset.token, password: PASSWORD })).json()).toEqual({ status: 'password_reset' });
    expect((await call(null, 'POST', '/v1/auth/login', { email: victim, password: 'squatters-own-passphrase' })).statusCode).toBe(401);
    const signedIn = await call(null, 'POST', '/v1/auth/login', { email: victim, password: PASSWORD });
    expect(signedIn.json()).toMatchObject({ status: 'signed_in', user: { emailVerified: true } });
    const userId = signedIn.json<{ user: { id: string } }>().user.id;
    expect(await events(userId)).toEqual(
      expect.arrayContaining([
        { action: 'auth.email_verified', outcome: 'denied', reason: 'password_required' },
        { action: 'auth.email_verified', outcome: 'denied', reason: 'bad_password' },
      ]),
    );
  });

  it('verifies in another browser with the password, and in the signing-up browser without it', async () => {
    const email = newEmail();
    const since = sink.messages.length;
    await call(new Jar(), 'POST', '/v1/auth/signup', { email, password: PASSWORD });
    const { token } = await mailTo(email, '/auth/verify', since);
    const phone = new Jar();
    expect((await call(phone, 'POST', '/v1/auth/verify-email', { token, password: PASSWORD })).json()).toMatchObject({ status: 'signed_in', user: { emailVerified: true } });
    // A forged sign-up cookie does not stand in for the password.
    const other = newEmail();
    const otherSince = sink.messages.length;
    await call(null, 'POST', '/v1/auth/signup', { email: other, password: PASSWORD });
    const forged = new Jar();
    forged.cookies.set('__Host-fr_signup', randomBytes(32).toString('base64url'));
    const otherToken = (await mailTo(other, '/auth/verify', otherSince)).token;
    expect((await call(forged, 'POST', '/v1/auth/verify-email', { token: otherToken })).json()).toMatchObject({ code: 'PASSWORD_REQUIRED' });
  });

  it('names the account of an emailed link before it is used, and refuses a dead link', async () => {
    const { email } = await signedUp();
    const since = sink.messages.length;
    await call(null, 'POST', '/v1/auth/magic-link', { email });
    const { token } = await mailTo(email, '/auth/magic', since);
    expect((await call(null, 'POST', '/v1/auth/link', { token, purpose: 'magic_link' })).json()).toEqual({ email, passwordRequired: false });
    expect((await call(null, 'POST', '/v1/auth/link', { token, purpose: 'verify_email' })).statusCode).toBe(400);
    expect((await call(null, 'POST', '/v1/auth/magic-link/verify', { token })).json()).toMatchObject({ status: 'signed_in' });
    const dead = await call(null, 'POST', '/v1/auth/link', { token, purpose: 'magic_link' }, { 'x-request-id': `dead-link-${token.slice(0, 8)}` });
    expect(dead.json()).toMatchObject({ code: 'INVALID_TOKEN' });
    expect(await pending(`event->>'requestId' = $1`, [`dead-link-${token.slice(0, 8)}`])).toEqual([
      expect.objectContaining({ action: 'auth.link_checked', outcome: 'denied', reason: 'invalid_token' }),
    ]);
  });

  it('audits two-factor requests that do not fit the account’s state, and a sign-out with the development header', async () => {
    const { jar, userId } = await signedUp();
    expect((await call(jar, 'POST', '/v1/auth/mfa/totp/disable', { code: '123456' })).statusCode).toBe(409);
    expect((await call(jar, 'POST', '/v1/auth/mfa/recovery-codes', { code: '123456' })).statusCode).toBe(409);
    expect((await call(jar, 'POST', '/v1/auth/mfa/totp/verify', { code: '123456' })).statusCode).toBe(409);
    await enrol(jar);
    expect((await call(jar, 'POST', '/v1/auth/mfa/totp/setup')).statusCode).toBe(409);
    expect(await events(userId)).toEqual(
      expect.arrayContaining([
        { action: 'auth.totp_disabled', outcome: 'denied', reason: 'not_enabled' },
        { action: 'auth.recovery_codes_issued', outcome: 'denied', reason: 'not_enabled' },
        { action: 'auth.totp_enabled', outcome: 'denied', reason: 'not_set_up' },
        { action: 'auth.totp_enabled', outcome: 'denied', reason: 'already_enabled' },
      ]),
    );

    const dev = await start({ AUTH_DEV_HEADERS: 'true' }, { authLimits: ROOMY });
    expect((await call(null, 'POST', '/v1/auth/logout', undefined, { 'x-fr-dev-user': userId }, dev)).statusCode).toBe(204);
    expect(await pending(`event->>'action' = 'auth.logout' and event->>'actorId' = $1 and event->'metadata'->>'devHeader' = 'true'`, [userId])).toEqual([
      expect.objectContaining({ outcome: 'success' }),
    ]);
  });

  it('never uses up a recovery code without the sign-in: two requests racing on one ticket spend one code', async () => {
    const { jar, email } = await signedUp();
    const { recoveryCodes } = await enrol(jar);
    await call(jar, 'POST', '/v1/auth/logout');
    const { ticket } = (await call(null, 'POST', '/v1/auth/login', { email, password: PASSWORD })).json<{ ticket: string }>();
    // A wrong code leaves the ticket usable.
    expect((await call(null, 'POST', '/v1/auth/mfa/recovery', { ticket, code: 'AAAA-AAAA-AAAA-AAAA' })).statusCode).toBe(401);
    const [a, b] = await Promise.all([
      call(null, 'POST', '/v1/auth/mfa/recovery', { ticket, code: recoveryCodes[0]! }),
      call(null, 'POST', '/v1/auth/mfa/recovery', { ticket, code: recoveryCodes[1]! }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    const winner = (a.statusCode === 200 ? a : b).json<{ recoveryCodesLeft: number }>();
    expect(winner.recoveryCodesLeft).toBe(9);
    // The losing request's code is still good.
    const loser = a.statusCode === 200 ? recoveryCodes[1]! : recoveryCodes[0]!;
    const again = (await call(null, 'POST', '/v1/auth/login', { email, password: PASSWORD })).json<{ ticket: string }>();
    expect((await call(null, 'POST', '/v1/auth/mfa/recovery', { ticket: again.ticket, code: loser })).json()).toMatchObject({ status: 'signed_in', recoveryCodesLeft: 8 });
  });

  it('signs in with a magic link, once', async () => {
    const { email, userId } = await signedUp();
    const since = sink.messages.length;
    expect((await call(null, 'POST', '/v1/auth/magic-link', { email })).json()).toEqual({ status: 'link_sent' });
    expect((await call(null, 'POST', '/v1/auth/magic-link', { email: newEmail() })).json()).toEqual({ status: 'link_sent' });
    const { token, subject } = await mailTo(email, '/auth/magic', since);
    expect(subject).toBe('Your sign-in link');
    const jar = new Jar();
    expect((await call(jar, 'POST', '/v1/auth/magic-link/verify', { token })).json()).toMatchObject({ status: 'signed_in', user: { id: userId } });
    expect((await call(jar, 'GET', '/v1/me')).json()).toMatchObject({ session: { mfaLevel: 'link' } });
    expect((await call(null, 'POST', '/v1/auth/magic-link/verify', { token })).statusCode).toBe(400);
  });

  it('resets a password with a link, keeps the link through a refused password and revokes every session', async () => {
    const { jar, email, userId } = await signedUp();
    const since = sink.messages.length;
    await call(null, 'POST', '/v1/auth/password/forgot', { email });
    const { token } = await mailTo(email, '/auth/reset', since);
    expect((await call(null, 'POST', '/v1/auth/password/reset', { token, password: 'qwerty123' })).statusCode).toBe(422);
    expect((await call(null, 'POST', '/v1/auth/password/reset', { token, password: 'a-brand-new-passphrase' })).json()).toEqual({ status: 'password_reset' });
    expect((await call(null, 'POST', '/v1/auth/password/reset', { token, password: 'a-brand-new-passphrase' })).statusCode).toBe(400);
    expect((await call(jar, 'GET', '/v1/me')).statusCode).toBe(401);
    expect((await call(null, 'POST', '/v1/auth/login', { email, password: PASSWORD })).statusCode).toBe(401);
    expect((await call(null, 'POST', '/v1/auth/login', { email, password: 'a-brand-new-passphrase' })).json()).toMatchObject({ status: 'signed_in' });
    expect(await events(userId)).toEqual(expect.arrayContaining([{ action: 'auth.password_reset', outcome: 'success' }]));
  });

  it('turns TOTP off with a code and rotates the session back to the first factor', async () => {
    const { jar } = await signedUp();
    const { secret } = await enrol(jar);
    expect((await call(jar, 'POST', '/v1/auth/mfa/totp/disable', { code: await wrongCode(secret) })).statusCode).toBe(401);
    expect((await call(jar, 'POST', '/v1/auth/mfa/totp/disable', { code: await codeFor(secret, 1) })).statusCode).toBe(204);
    expect((await call(jar, 'GET', '/v1/me')).json()).toMatchObject({ user: { totpEnabled: false }, session: { mfaLevel: 'link' } });
  });

  it('asks for a recent sign-in before an authenticator is set up, so a session taken over later cannot enrol one', async () => {
    const { jar, email, userId } = await signedUp();
    await owner.query(`update sessions set created_at = now() - interval '16 minutes' where user_id = $1`, [userId]);
    const res = await call(jar, 'POST', '/v1/auth/mfa/totp/setup');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'REAUTH_REQUIRED' });
    expect(await events(userId)).toEqual(expect.arrayContaining([{ action: 'auth.totp_enabled', outcome: 'denied', reason: 'reauth_required' }]));
    expect(await events(userId)).not.toEqual(expect.arrayContaining([expect.objectContaining({ action: 'request.authorize' })]));

    // Signing in again is enough.
    const fresh = new Jar();
    expect((await call(fresh, 'POST', '/v1/auth/login', { email, password: PASSWORD })).json()).toMatchObject({ status: 'signed_in' });
    await enrol(fresh);
  });
});

describe('throttling', () => {
  it('limits attempts per IP and account with Retry-After, audited once per window', async () => {
    const limited = await start({}, { authLimits: { auth_login: { max: 2, windowSeconds: 900 } } });
    const email = newEmail();
    for (let i = 0; i < 2; i++) expect((await call(null, 'POST', '/v1/auth/login', { email, password: 'x' }, {}, limited)).statusCode).toBe(401);
    const third = await call(null, 'POST', '/v1/auth/login', { email, password: 'x' }, {}, limited);
    expect(third.statusCode).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    await call(null, 'POST', '/v1/auth/login', { email, password: 'x' }, {}, limited);
    const throttled = await pending(`event->>'action' = 'auth.throttled' and event->>'requestId' = any($1)`, [[third.headers['x-request-id']]]);
    expect(throttled).toEqual([expect.objectContaining({ reason: 'auth_login', metadata: { bucket: 'auth_login', limit: 2, windowSeconds: 900 } })]);
    // Another account from the same IP is not held up.
    expect((await call(null, 'POST', '/v1/auth/login', { email: newEmail(), password: 'x' }, {}, limited)).statusCode).toBe(401);
  });

  it('counts signed-in second-factor checks against the user across IPs, so a stolen session cannot guess codes', async () => {
    const limited = await start({}, { authLimits: { ...ROOMY, auth_mfa: { max: 3, windowSeconds: 3600 } } });
    const { jar, userId } = await signedUp();
    const { secret } = await enrol(jar);
    const bad = await wrongCode(secret);
    for (let i = 0; i < 3; i++) expect((await call(jar, 'POST', '/v1/auth/mfa/totp/disable', { code: bad }, {}, limited)).statusCode).toBe(401);
    const spent = await call(jar, 'POST', '/v1/auth/mfa/totp/disable', { code: await codeFor(secret, 1) }, {}, limited);
    expect(spent.statusCode).toBe(429);
    expect(Number(spent.headers['retry-after'])).toBeGreaterThan(0);
    expect((await call(jar, 'POST', '/v1/auth/mfa/recovery-codes', { code: await codeFor(secret, 1) }, {}, limited)).statusCode).toBe(429);
    expect((await call(jar, 'GET', '/v1/me')).json()).toMatchObject({ user: { totpEnabled: true } });
    expect(await events(userId)).toEqual(expect.arrayContaining([{ action: 'auth.throttled', outcome: 'denied', reason: 'auth_mfa' }]));
  });

  it('steps a much-attacked account up to an emailed link instead of locking its owner out', async () => {
    const limited = await start({}, { authLimits: { ...ROOMY, auth_account: { max: 3, windowSeconds: 3600 } } });
    const { email, userId } = await signedUp();
    const since = sink.messages.length;
    // Wrong passwords from one IP use up the account's budget across IPs ...
    for (let i = 0; i < 3; i++) expect((await call(null, 'POST', '/v1/auth/login', { email, password: `guess-${i}` }, {}, limited)).statusCode).toBe(401);
    // ... after which a sign-in answers the same whatever the password, and never a session.
    const guess = await call(null, 'POST', '/v1/auth/login', { email, password: 'guess-again' }, {}, limited);
    const owner = new Jar();
    const right = await call(owner, 'POST', '/v1/auth/login', { email, password: PASSWORD }, {}, limited);
    expect(guess.statusCode).toBe(200);
    expect(right.statusCode).toBe(200);
    expect(guess.json()).toEqual({ status: 'link_sent' });
    expect(right.json()).toEqual({ status: 'link_sent' });
    expect(owner.session).toBeUndefined();
    expect(right.headers['set-cookie']).toBeUndefined();
    // Only the right password mailed a link, and it signs the owner in.
    const link = await mailTo(email, '/auth/magic', since);
    expect(await subjectsTo(email, since)).toEqual(['Your sign-in link']);
    expect((await call(owner, 'POST', '/v1/auth/magic-link/verify', { token: link.token }, {}, limited)).json()).toMatchObject({ status: 'signed_in', user: { id: userId } });
    // The emailed links the owner asks for are not held up by the guesses either.
    expect((await call(null, 'POST', '/v1/auth/magic-link', { email }, {}, limited)).statusCode).toBe(202);
    expect((await call(null, 'POST', '/v1/auth/password/forgot', { email }, {}, limited)).statusCode).toBe(202);
    expect(await pending(`event->>'requestId' = $1`, [guess.headers['x-request-id']])).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'auth.throttled', reason: 'auth_account' }), expect.objectContaining({ action: 'auth.login', reason: 'bad_password' })]),
    );
    expect(await events(userId)).toEqual(
      expect.arrayContaining([
        { action: 'auth.login', outcome: 'denied', reason: 'step_up_link' },
        { action: 'auth.magic_link_sent', outcome: 'success', reason: 'step_up' },
      ]),
    );
  });

  it('caps the links mailed to one address, whoever asks for them', async () => {
    const limited = await start({}, { authLimits: { ...ROOMY, auth_mail: { max: 2, windowSeconds: 3600 } } });
    const { email } = await signedUp();
    expect((await call(null, 'POST', '/v1/auth/magic-link', { email }, {}, limited)).statusCode).toBe(202);
    expect((await call(null, 'POST', '/v1/auth/password/forgot', { email }, {}, limited)).statusCode).toBe(202);
    const third = await call(null, 'POST', '/v1/auth/magic-link', { email }, {}, limited);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ code: 'RATE_LIMITED', detail: expect.stringMatching(/newest link/) });
    // Password sign-in is a different budget.
    expect((await call(null, 'POST', '/v1/auth/login', { email, password: PASSWORD }, {}, limited)).json()).toMatchObject({ status: 'signed_in' });
  });

  it('counts junk session cookies on other routes against the IP, so they cannot flood the audit chain', async () => {
    const limited = await start({}, { authLimits: { auth_any: { max: 2, windowSeconds: 60 } } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await call(null, 'GET', '/v1/forms', undefined, { cookie: `__Host-fr_sess=junk-${i}`, 'x-request-id': `junk-cookie-${i}` }, limited)).statusCode);
    expect(codes).toEqual([401, 401, 429, 429]);
    const rejected = await pending(`event->>'action' = 'auth.session_rejected' and event->>'requestId' like 'junk-cookie-%'`, []);
    expect(rejected).toHaveLength(2);
  });

  it('limits every auth request per IP', async () => {
    const limited = await start({}, { authLimits: { auth_any: { max: 3, windowSeconds: 60 } } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await call(null, 'GET', '/v1/auth/methods', undefined, {}, limited)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
  });
});

describe('Google and Microsoft sign-in (OIDC, SaaS only)', () => {
  beforeEach(() => {
    google.nextUser = null;
    google.tamperNextIdToken = null;
  });

  /** start → provider → callback, as the browser follows the redirects. */
  async function oauth(jar: Jar): Promise<LightMyRequestResponse> {
    const startRes = await call(jar, 'GET', '/v1/auth/oauth/google/start');
    expect(startRes.statusCode).toBe(302);
    const callback = new URL(await google.authorize(startRes.headers.location as string));
    return call(jar, 'GET', `${callback.pathname}${callback.search}`);
  }

  it('starts with PKCE (S256), state and nonce, and offers the configured providers', async () => {
    expect((await call(null, 'GET', '/v1/auth/methods')).json()).toEqual({ password: true, emailLinks: true, oauth: ['google'] });
    const res = await call(new Jar(), 'GET', '/v1/auth/oauth/google/start');
    const url = new URL(res.headers.location as string);
    expect(url.origin).toBe(google.issuer);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'fr-google',
      redirect_uri: `${API}/v1/auth/oauth/google/callback`,
      response_type: 'code',
      code_challenge_method: 'S256',
      scope: 'openid email profile',
    });
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(res.cookies.find((c) => c.name === '__Host-fr_oauth')).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax', path: '/' });
    expect((await call(null, 'GET', '/v1/auth/oauth/microsoft/start')).statusCode).toBe(404);
  });

  it('creates a verified account at the first sign-in, then finds it by the linked identity', async () => {
    const email = newEmail();
    google.nextUser = { sub: `g-${randomUUID()}`, email, email_verified: true, name: 'Ravi' };
    const jar = new Jar();
    const res = await oauth(jar);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`${BUILDER}/forms`);
    const me = (await call(jar, 'GET', '/v1/me')).json<{ user: { id: string; emailVerified: boolean; name: string }; session: { mfaLevel: string } }>();
    expect(me).toMatchObject({ user: { email, emailVerified: true, name: 'Ravi' }, session: { mfaLevel: 'oauth' } });
    expect(await events(me.user.id)).toEqual(expect.arrayContaining([{ action: 'auth.oauth_linked', outcome: 'success' }]));

    // The provider may change the address; the identity still leads to the same user.
    google.nextUser = { ...google.nextUser, email: newEmail() };
    const second = new Jar();
    await oauth(second);
    expect((await call(second, 'GET', '/v1/me')).json()).toMatchObject({ user: { id: me.user.id } });
  });

  it('links a verified address to the existing account and still asks for its second factor', async () => {
    const { jar, email, userId } = await signedUp();
    await enrol(jar);
    google.nextUser = { sub: `g-${randomUUID()}`, email, email_verified: true };
    const res = await oauth(new Jar());
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(new RegExp(`^${BUILDER}/auth/mfa#ticket=[A-Za-z0-9_-]{43}$`));
    expect(res.cookies.find((c) => c.name === '__Host-fr_sess')).toBeUndefined();
    expect(await events(userId)).toEqual(expect.arrayContaining([{ action: 'auth.oauth_linked', outcome: 'success' }, { action: 'auth.mfa_challenged', outcome: 'success' }]));
  });

  it('refuses an unverified address, a tampered ID token, a missing transaction and a denied consent', async () => {
    google.nextUser = { sub: `g-${randomUUID()}`, email: newEmail(), email_verified: false };
    expect((await oauth(new Jar())).headers.location).toBe(`${BUILDER}/auth/sign-in#error=oauth_email_unverified`);

    google.nextUser = { sub: `g-${randomUUID()}`, email: newEmail(), email_verified: true };
    google.tamperNextIdToken = (claims) => ({ ...claims, nonce: 'replayed' });
    expect((await oauth(new Jar())).headers.location).toBe(`${BUILDER}/auth/sign-in#error=oauth_failed`);

    const startRes = await call(new Jar(), 'GET', '/v1/auth/oauth/google/start');
    const callback = new URL(await google.authorize(startRes.headers.location as string));
    const noCookie = await call(new Jar(), 'GET', `${callback.pathname}${callback.search}`);
    expect(noCookie.headers.location).toBe(`${BUILDER}/auth/sign-in#error=oauth_failed`);

    google.nextUser = null;
    expect((await oauth(new Jar())).headers.location).toBe(`${BUILDER}/auth/sign-in#error=oauth_failed`);
    const refusals = await pending(`event->>'action' = 'auth.login' and event->>'outcome' = 'denied' and event->'metadata'->>'method' = 'oauth_google'`, []);
    expect(refusals.map((e) => e.reason)).toEqual(expect.arrayContaining(['oauth_email_unverified', 'oauth_refused', 'oauth_no_transaction']));
  });

  // openid-client maps Entra ID's `{tenantid}` issuer only for login.microsoftonline.com, so that part stays with the
  // staging smoke test (BL-204); the claims and the routes are covered here.
  it('signs in with Microsoft when Entra ID vouches for the address (xms_edov), and refuses an unvouched one', async () => {
    const microsoft = await startMockOidcProvider({
      clients: [{ clientId: 'fr-microsoft', clientSecret: 'microsoft-test-secret', redirectUris: [`${API}/v1/auth/oauth/microsoft/callback`] }],
    });
    try {
      const ms = await start({ OIDC_MICROSOFT_CLIENT_ID: 'fr-microsoft', OIDC_MICROSOFT_CLIENT_SECRET: 'microsoft-test-secret', OIDC_MICROSOFT_ISSUER: microsoft.issuer });
      expect((await call(null, 'GET', '/v1/auth/methods', undefined, {}, ms)).json()).toMatchObject({ oauth: ['google', 'microsoft'] });
      const signIn = async (jar: Jar) => {
        const startRes = await call(jar, 'GET', '/v1/auth/oauth/microsoft/start', undefined, {}, ms);
        expect(new URL(startRes.headers.location as string).searchParams.get('code_challenge_method')).toBe('S256');
        const callback = new URL(await microsoft.authorize(startRes.headers.location as string));
        return call(jar, 'GET', `${callback.pathname}${callback.search}`, undefined, {}, ms);
      };

      const email = newEmail();
      microsoft.nextUser = { sub: `m-${randomUUID()}`, email, name: 'Meera', claims: { xms_edov: true, tid: randomUUID() } };
      const jar = new Jar();
      expect((await signIn(jar)).headers.location).toBe(`${BUILDER}/forms`);
      const me = (await call(jar, 'GET', '/v1/me', undefined, {}, ms)).json<{ user: { id: string } }>();
      expect(me).toMatchObject({ user: { email, emailVerified: true, name: 'Meera' }, session: { mfaLevel: 'oauth' } });
      expect(await events(me.user.id)).toEqual(expect.arrayContaining([{ action: 'auth.oauth_linked', outcome: 'success' }]));

      microsoft.nextUser = { sub: `m-${randomUUID()}`, email: newEmail(), claims: { tid: randomUUID() } };
      expect((await signIn(new Jar())).headers.location).toBe(`${BUILDER}/auth/sign-in#error=oauth_email_unverified`);
      const refusals = await pending(`event->>'action' = 'auth.login' and event->>'outcome' = 'denied' and event->'metadata'->>'method' = 'oauth_microsoft'`, []);
      expect(refusals.map((e) => e.reason)).toContain('oauth_email_unverified');
    } finally {
      await microsoft.close();
    }
  });

  it('is hidden on-prem, so air-gapped installs have no OAuth routes', async () => {
    for (const env of [{ DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none' }, { DEPLOYMENT_MODE: 'onprem' }]) {
      const cfg = config(env);
      expect(cfg.auth.oidc).toEqual({});
      expect(cfg.notices).toContain('OIDC_GOOGLE_* is ignored: Google and Microsoft sign-in are SaaS only (ADR-0017)');
      const onprem = await start(env);
      expect((await call(null, 'GET', '/v1/auth/methods', undefined, {}, onprem)).json()).toMatchObject({ oauth: [] });
      expect((await call(null, 'GET', '/v1/auth/oauth/google/start', undefined, {}, onprem)).statusCode).toBe(404);
    }
  });
});
