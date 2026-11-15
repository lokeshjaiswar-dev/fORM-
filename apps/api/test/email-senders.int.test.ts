import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createKeyfileKeyProvider, createOrgSecrets } from '@form/adapters/kms';
import { provision } from '@form/db';
import { PortError, type MailMessage, type MailVerifyResult, type Mailer, type OrgSecrets } from '@form/ports';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { MAIL_ADDRESS_REFUSED, MAIL_ADDRESS_UNRESOLVED } from '../src/routes/email-senders.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

/*
 * WP-1.16 email senders (NOT-01): the SMTP URL is sealed and never comes back, a test send records whether the sender
 * works, a failed one stores only a scrubbed error, and none of it crosses an org. The cross-org cases of every route are
 * also in the isolation suite (isolation-cases/notifications.ts); this file proves the behaviour inside one org.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const URL_A = 'smtps://relay-user-a1:relay-pass-Zk39q@smtp.sender-a.test:465';
const PASSWORD_A = 'relay-pass-Zk39q';
const FROM_A = 'hello-a1@sender-a.test';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
interface Sender {
  id: string;
  name: string;
  fromAddress: string;
  fromName: string | null;
  verifiedAt: string | null;
  smtp: { host: string; port: number; secure: boolean; username: string | null } | null;
  lastTestError: string | null;
}

let app: FastifyInstance;
let appWithoutKeys: FastifyInstance;
let owner: pg.Pool;
let orgSecrets: OrgSecrets;
let orgId: string;
let otherOrgId: string;
let formId: string;
const user: Record<'owner' | 'admin' | 'editor' | 'creator' | 'viewer' | 'otherOwner', string> = {
  owner: randomUUID(),
  admin: randomUUID(),
  editor: randomUUID(),
  creator: randomUUID(),
  viewer: randomUUID(),
  otherOwner: randomUUID(),
};
const emailOf = (id: string) => `${id.slice(0, 8)}@senders.test`;

/** The org mailer the routes get: the test sets what it answers and reads what it was asked. */
const mailer = {
  orgs: [] as string[],
  verifyCalls: [] as Array<string | undefined>,
  sent: [] as MailMessage[],
  verifyResult: { ok: true } as MailVerifyResult,
  sendError: undefined as Error | undefined,
  reset() {
    this.orgs = [];
    this.verifyCalls = [];
    this.sent = [];
    this.verifyResult = { ok: true };
    this.sendError = undefined;
  },
  make(org: string): Mailer {
    this.orgs.push(org);
    return {
      verify: async (ref) => {
        this.verifyCalls.push(ref);
        return this.verifyResult;
      },
      send: async (m) => {
        if (this.sendError) throw this.sendError;
        this.sent.push(m);
        return { messageId: '<test@sender-a.test>', refused: [] };
      },
    };
  },
};

const call = (method: Method, url: string, o: { as?: string; org?: string; body?: unknown; on?: FastifyInstance } = {}) =>
  (o.on ?? app).inject({
    method,
    url,
    headers: { 'x-fr-dev-user': o.as ?? user.owner, 'x-fr-org': o.org ?? orgId, ...BROWSER },
    ...(o.body === undefined ? {} : { payload: o.body as Record<string, unknown> }),
  });

async function create(over: Record<string, unknown> = {}): Promise<Sender> {
  const res = await call('POST', '/v1/email-senders', { body: { name: 'Org mailbox', fromAddress: FROM_A, smtpUrl: URL_A, ...over } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Sender>();
}

const senderRow = async (id: string) =>
  (await owner.query<{ id: string; org_id: string; name: string; from_address: string; from_name: string | null; smtp_secret_id: string; verified_at: Date | null; last_test_error: string | null }>('select * from email_senders where id = $1', [id])).rows[0];
const secretRow = async (id: string) => (await owner.query<{ id: string; org_id: string; kind: string; enc: Record<string, unknown>; meta: Record<string, unknown> }>('select * from secrets where id = $1', [id])).rows[0];

async function auditEvents(orgKey: string, action: string, resourceId?: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `select event from audit_pending where org_key = $1 and event->>'action' = $2 and ($3::text is null or event->>'resourceId' = $3) order by id`,
    [orgKey, action, resourceId ?? null],
  );
  return rows.map((r) => r.event);
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_email_senders');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  orgId = randomUUID();
  otherOrgId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2), ($3, $4, $4)', [orgId, 'senders-a', otherOrgId, 'senders-b']);
  const members: Array<[string, string, string]> = [
    [user.owner, 'owner', orgId],
    [user.admin, 'admin', orgId],
    [user.editor, 'editor', orgId],
    [user.creator, 'creator', orgId],
    [user.viewer, 'viewer', orgId],
    [user.otherOwner, 'owner', otherOrgId],
  ];
  for (const [id, role, org] of members) {
    await owner.query('insert into users (id, email, email_norm, name) values ($1, $2, $2, $3)', [id, emailOf(id), role]);
    await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [org, id, role]);
  }
  const parsed = parseConfig({
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'onprem',
    DATABASE_URL: urls.fr_app,
    AUTH_DEV_HEADERS: 'true',
    AUTH_SECRET: Buffer.alloc(32, 9).toString('base64url'),
    LOG_LEVEL: 'silent',
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  const keys = createKeyfileKeyProvider({ masterKey: randomBytes(32) });
  orgSecrets = createOrgSecrets(keys);
  app = await buildApp(parsed.config, { underPressure: false, keys, orgSecrets, orgMailer: (org) => mailer.make(org) });
  // The same database with neither the key service nor the org mailer, as an install that has not configured them.
  appWithoutKeys = await buildApp(parsed.config, { underPressure: false });
  const created = await call('POST', '/v1/forms', { body: { title: 'Sender form' } });
  formId = created.json<{ id: string }>().id;
  const draft = draftWith(formId, [fieldBlock('name', 'short_text', {}, { required: true })], 'Sender form');
  expect((await app.inject({ method: 'PUT', url: `/v1/forms/${formId}/draft`, headers: { 'x-fr-dev-user': user.owner, 'x-fr-org': orgId, 'if-match': '0', ...BROWSER }, payload: { draft } as never })).statusCode).toBe(200);
});

afterAll(async () => {
  await app?.close();
  await appWithoutKeys?.close();
  await owner?.end();
});

describe('what is stored and what is returned', () => {
  it('never returns the SMTP URL or anything sealed, and keeps it out of secrets.enc in plaintext', async () => {
    const made = await create();
    const list = await call('GET', '/v1/email-senders');
    expect(list.statusCode, list.body).toBe(200);
    for (const text of [JSON.stringify(made), list.body]) {
      for (const secret of [URL_A, PASSWORD_A, 'relay-user-a1:', 'smtps://']) expect(text, secret).not.toContain(secret);
      for (const key of ['smtpUrl', 'enc', 'dek', 'kekRef', 'ciphertext', 'ct']) expect(text, key).not.toContain(`"${key}"`);
    }
    // What the UI may show about the relay is the host, the port, the TLS mode and the user name.
    expect(made).toMatchObject({ name: 'Org mailbox', fromAddress: FROM_A, fromName: null, verifiedAt: null, lastTestError: null, smtp: { host: 'smtp.sender-a.test', port: 465, secure: true, username: 'relay-user-a1' } });

    // At rest: a secrets row of kind smtp for this org, sealed, with a meta that holds no password.
    const sender = (await senderRow(made.id))!;
    const secret = (await secretRow(sender.smtp_secret_id))!;
    expect(secret).toMatchObject({ org_id: orgId, kind: 'smtp', meta: { host: 'smtp.sender-a.test', port: 465, secure: true, username: 'relay-user-a1' } });
    for (const needle of [URL_A, PASSWORD_A, 'relay-user-a1', 'smtp.sender-a.test']) {
      expect(JSON.stringify(secret.enc), needle).not.toContain(needle);
      expect(JSON.stringify(secret.meta), needle).not.toContain(PASSWORD_A);
    }
    // It really is the sealed URL: the org's own key context opens it, and no other org's, secret id's or kind's does.
    const open = (ctx: { orgId: string; secretId: string; kind: string }) => orgSecrets.open(ctx, secret.enc);
    expect(new TextDecoder().decode(await open({ orgId, secretId: secret.id, kind: 'smtp' }))).toBe(URL_A);
    await expect(open({ orgId: otherOrgId, secretId: secret.id, kind: 'smtp' })).rejects.toThrow();
    await expect(open({ orgId, secretId: randomUUID(), kind: 'smtp' })).rejects.toThrow();
    await expect(open({ orgId, secretId: secret.id, kind: 'webhook_hmac' })).rejects.toThrow();
  });

  it('seals two senders with the same URL to different stored values', async () => {
    const [a, b] = [await create({ name: 'First' }), await create({ name: 'Second' })];
    const [encA, encB] = await Promise.all([a, b].map(async (s) => JSON.stringify((await secretRow((await senderRow(s.id))!.smtp_secret_id))!.enc)));
    expect(encA).not.toBe(encB);
  });

  it('refuses a URL that is not smtp:// or smtps://, a bad address and a display name that could end a header line, without echoing the URL', async () => {
    const bad = [
      { smtpUrl: 'https://relay-user:topsecret-9x@example.test/' },
      { smtpUrl: 'smtp://' },
      { smtpUrl: 'smtp://host with space:25' },
      { smtpUrl: 'not a url topsecret-9x' },
      { fromAddress: 'not-an-address' },
      { fromName: 'Billing\r\nBcc: attacker@example.test' },
      { fromName: 'Billing <x@y.test>' },
      { name: '' },
    ];
    for (const over of bad) {
      const res = await call('POST', '/v1/email-senders', { body: { name: 'Bad', fromAddress: FROM_A, smtpUrl: URL_A, ...over } });
      expect(res.statusCode, JSON.stringify(over) + res.body).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(res.body).not.toContain('topsecret-9x');
    }
    const extra = await call('POST', '/v1/email-senders', { body: { name: 'Bad', fromAddress: FROM_A, smtpUrl: URL_A, smtpSecretId: randomUUID() } });
    expect(extra.statusCode).toBe(400);
  });
});

describe('who may do what', () => {
  it('lets only org.settings write: owner and admin may, an editor, a creator and a viewer get 403 and a request.authorize denied record', async () => {
    const made = await create();
    for (const who of ['editor', 'creator', 'viewer'] as const) {
      const as = user[who];
      const results = [
        await call('POST', '/v1/email-senders', { as, body: { name: 'No', fromAddress: FROM_A, smtpUrl: URL_A } }),
        await call('PATCH', `/v1/email-senders/${made.id}`, { as, body: { name: 'No' } }),
        await call('DELETE', `/v1/email-senders/${made.id}`, { as }),
        await call('POST', `/v1/email-senders/${made.id}/test`, { as }),
      ];
      for (const res of results) {
        expect(res.statusCode, `${who}: ${res.body}`).toBe(403);
        const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'requestId' = $2`, [orgId, res.headers['x-request-id']]);
        expect(rows.map((r) => r.event)).toEqual([expect.objectContaining({ action: 'request.authorize', outcome: 'denied', actorId: as, reason: 'missing_permission:org.settings' })]);
      }
    }
    expect((await senderRow(made.id))!.name).toBe('Org mailbox');
    const byAdmin = await call('POST', '/v1/email-senders', { as: user.admin, body: { name: 'By admin', fromAddress: FROM_A, smtpUrl: URL_A } });
    expect(byAdmin.statusCode, byAdmin.body).toBe(201);
  });

  it('lets anyone with forms.read list the senders to pick one, with the relay and the test error left out for those without org.settings', async () => {
    const made = await create({ name: 'Visible to pickers' });
    const asEditor = await call('GET', '/v1/email-senders', { as: user.editor });
    expect(asEditor.statusCode, asEditor.body).toBe(200);
    const seen = asEditor.json<{ items: Sender[] }>().items.find((s) => s.id === made.id)!;
    expect(seen).toMatchObject({ name: 'Visible to pickers', fromAddress: FROM_A, smtp: null, lastTestError: null });
    const asAdmin = await call('GET', '/v1/email-senders', { as: user.admin });
    expect(asAdmin.json<{ items: Sender[] }>().items.find((s) => s.id === made.id)).toMatchObject({ smtp: { host: 'smtp.sender-a.test', username: 'relay-user-a1' } });
    expect((await call('GET', '/v1/email-senders', { as: user.viewer })).statusCode).toBe(200);
  });

  it('answers 503 for the routes that need the key service or the org mailer when the install has none, and still lists and deletes', async () => {
    const made = await create();
    const body = { name: 'No keys', fromAddress: FROM_A, smtpUrl: URL_A };
    expect((await call('POST', '/v1/email-senders', { on: appWithoutKeys, body })).statusCode).toBe(503);
    expect((await call('PATCH', `/v1/email-senders/${made.id}`, { on: appWithoutKeys, body: { smtpUrl: URL_A } })).statusCode).toBe(503);
    expect((await call('POST', `/v1/email-senders/${made.id}/test`, { on: appWithoutKeys })).statusCode).toBe(503);
    expect((await call('GET', '/v1/email-senders', { on: appWithoutKeys })).statusCode).toBe(200);
    // A rename needs no key.
    expect((await call('PATCH', `/v1/email-senders/${made.id}`, { on: appWithoutKeys, body: { name: 'Renamed without keys' } })).statusCode).toBe(200);
    expect((await call('DELETE', `/v1/email-senders/${made.id}`, { on: appWithoutKeys })).statusCode).toBe(204);
  });
});

describe('the test send', () => {
  it('leaves verified_at null and stores a scrubbed last_test_error when the mailer fails, and sets verified_at when it succeeds', async () => {
    const made = await create();
    const stored = (await senderRow(made.id))!;
    mailer.reset();
    mailer.verifyResult = { ok: false, error: `Invalid login: 535 5.7.8 Authentication failed (connect ${URL_A}) for mail from ${FROM_A}` };
    const failed = await call('POST', `/v1/email-senders/${made.id}/test`);
    expect(failed.statusCode, failed.body).toBe(200);
    expect(failed.json()).toMatchObject({ ok: false, verifiedAt: null, error: expect.stringContaining('Authentication failed') });
    const afterFail = (await senderRow(made.id))!;
    expect(afterFail.verified_at).toBeNull();
    expect(afterFail.last_test_error).toContain('Authentication failed');
    for (const secret of [URL_A, PASSWORD_A, 'smtps://', FROM_A, 'relay-pass']) {
      expect(afterFail.last_test_error, secret).not.toContain(secret);
      expect(failed.body, secret).not.toContain(secret);
    }
    expect(mailer.sent).toEqual([]);
    // The mailer was made for the caller's own org and asked about this sender's secret.
    expect(mailer.orgs).toEqual([orgId]);
    expect(mailer.verifyCalls).toEqual([stored.smtp_secret_id]);
    // The list shows the error to those who may manage senders.
    expect((await call('GET', '/v1/email-senders')).json<{ items: Sender[] }>().items.find((s) => s.id === made.id)!.lastTestError).toBe(afterFail.last_test_error);

    mailer.reset();
    const ok = await call('POST', `/v1/email-senders/${made.id}/test`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, error: null, verifiedAt: expect.any(String) });
    const afterOk = (await senderRow(made.id))!;
    expect(afterOk.verified_at).toBeInstanceOf(Date);
    expect(afterOk.last_test_error).toBeNull();
  });

  it('sends one message, from the sender, to the signed-in caller’s own address and nobody else’s, through this sender’s secret', async () => {
    const made = await create({ name: 'Billing desk', fromName: 'Billing' });
    mailer.reset();
    const asAdmin = await call('POST', `/v1/email-senders/${made.id}/test`, { as: user.admin });
    expect(asAdmin.statusCode, asAdmin.body).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    const sent = mailer.sent[0]!;
    expect(sent.to).toEqual([{ address: emailOf(user.admin) }]);
    expect(sent.cc ?? []).toEqual([]);
    expect(sent.bcc ?? []).toEqual([]);
    expect(sent.from).toEqual({ address: FROM_A, name: 'Billing' });
    expect(sent.senderSecretRef).toBe((await senderRow(made.id))!.smtp_secret_id);
    // A body cannot name another address: the route takes none.
    const withBody = await call('POST', `/v1/email-senders/${made.id}/test`, { body: { to: 'attacker@example.test' } });
    expect(withBody.statusCode, withBody.body).toBe(200);
    expect(mailer.sent.at(-1)!.to).toEqual([{ address: emailOf(user.owner) }]);
  });

  it('never returns or stores the address the egress guard resolved the relay to: a fixed sentence instead (no DNS oracle for internal names)', async () => {
    const made = await create();
    const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
    const IPV6 = /\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b|::1\b/i;
    const noAddress = async (res: { body: string }) => {
      const row = (await senderRow(made.id))!;
      for (const text of [res.body, row.last_test_error ?? '']) {
        expect(text).not.toMatch(IPV4);
        expect(text).not.toMatch(IPV6);
        expect(text).not.toContain('mail.internal');
      }
      return row;
    };

    // verify(): the guard's exact text for an internal name on SaaS.
    mailer.reset();
    mailer.verifyResult = { ok: false, code: 'egress_denied', error: 'egress to smtp://mail.internal:25 denied: 10.42.7.13 is not a public address' };
    const viaVerify = await call('POST', `/v1/email-senders/${made.id}/test`);
    expect(viaVerify.json()).toMatchObject({ ok: false, verifiedAt: null, error: MAIL_ADDRESS_REFUSED });
    expect((await noAddress(viaVerify)).last_test_error).toBe(MAIL_ADDRESS_REFUSED);

    // send() throwing the guard's refusal (an IPv6 answer this time).
    mailer.reset();
    mailer.sendError = new PortError('egress_denied', 'egress to smtp://mail.internal:25 denied: fd00:7:13::25 is not a public address');
    const viaSend = await call('POST', `/v1/email-senders/${made.id}/test`);
    expect(viaSend.json()).toMatchObject({ ok: false, error: MAIL_ADDRESS_REFUSED });
    await noAddress(viaSend);

    // A name that did not resolve: the guard keeps the resolver's error as the cause, and the answer says so without the guard's text.
    mailer.reset();
    mailer.sendError = new PortError('egress_denied', 'egress to mail.internal denied: it does not resolve', { cause: new Error('getaddrinfo ENOTFOUND mail.internal') });
    const unresolved = await call('POST', `/v1/email-senders/${made.id}/test`);
    expect(unresolved.json()).toMatchObject({ ok: false, error: MAIL_ADDRESS_UNRESOLVED });
    await noAddress(unresolved);
  });

  it('records a send that throws as a failed test, with the error scrubbed of addresses, and no echo of what it said', async () => {
    const made = await create();
    mailer.reset();
    mailer.sendError = new PortError('unavailable', `SMTP delivery failed: 550 5.1.1 <${emailOf(user.owner)}>: Recipient address rejected, relay ${URL_A}`);
    const res = await call('POST', `/v1/email-senders/${made.id}/test`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, verifiedAt: null });
    const row = (await senderRow(made.id))!;
    expect(row.verified_at).toBeNull();
    expect(row.last_test_error).toContain('Recipient address rejected');
    for (const secret of [URL_A, PASSWORD_A, emailOf(user.owner), 'smtps://']) expect(row.last_test_error, secret).not.toContain(secret);

    mailer.reset();
    mailer.sendError = new TypeError(`boom ${URL_A}`);
    const unexpected = await call('POST', `/v1/email-senders/${made.id}/test`);
    expect(unexpected.statusCode, unexpected.body).toBe(200);
    expect((await senderRow(made.id))!.last_test_error).not.toContain(PASSWORD_A);
  });

  it('clears the verification when the relay or the From address changes, and keeps it when only the name does', async () => {
    const made = await create();
    mailer.reset();
    expect((await call('POST', `/v1/email-senders/${made.id}/test`)).json()).toMatchObject({ ok: true });
    expect((await senderRow(made.id))!.verified_at).not.toBeNull();

    expect((await call('PATCH', `/v1/email-senders/${made.id}`, { body: { name: 'Renamed' } })).json<Sender>().verifiedAt).not.toBeNull();
    const moved = await call('PATCH', `/v1/email-senders/${made.id}`, { body: { fromAddress: 'new-address@sender-a.test' } });
    expect(moved.json<Sender>()).toMatchObject({ verifiedAt: null, lastTestError: null });

    expect((await call('POST', `/v1/email-senders/${made.id}/test`)).json()).toMatchObject({ ok: true });
    const rotated = await call('PATCH', `/v1/email-senders/${made.id}`, { body: { smtpUrl: 'smtp://relay-2.sender-a.test:587' } });
    expect(rotated.json<Sender>()).toMatchObject({ verifiedAt: null, smtp: { host: 'relay-2.sender-a.test', port: 587, secure: false, username: null } });
  });
});

describe('changing and deleting', () => {
  it('replaces the sealed secret on a new SMTP URL and deletes the old one, audited by key and never by value', async () => {
    const made = await create();
    const before = (await senderRow(made.id))!;
    const newUrl = 'smtps://rotated-user:rotated-pass-Q7@smtp.rotated.test:465';
    const res = await call('PATCH', `/v1/email-senders/${made.id}`, { body: { smtpUrl: newUrl, fromName: 'Accounts' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain('rotated-pass-Q7');
    const after = (await senderRow(made.id))!;
    expect(after.smtp_secret_id).not.toBe(before.smtp_secret_id);
    expect(await secretRow(before.smtp_secret_id)).toBeUndefined();
    const fresh = (await secretRow(after.smtp_secret_id))!;
    expect(new TextDecoder().decode(await orgSecrets.open({ orgId, secretId: fresh.id, kind: 'smtp' }, fresh.enc))).toBe(newUrl);
    expect(JSON.stringify(fresh)).not.toContain('rotated-pass-Q7');

    const events = await auditEvents(orgId, 'email_sender.saved', made.id);
    expect(events).toEqual([
      expect.objectContaining({ actorId: user.owner, metadata: expect.objectContaining({ change: 'created', changedKeys: ['name', 'fromAddress', 'smtpUrl'] }) }),
      expect.objectContaining({ metadata: expect.objectContaining({ change: 'updated', changedKeys: ['fromName', 'smtpUrl'] }) }),
    ]);
    const everything = JSON.stringify(events);
    for (const secret of [URL_A, PASSWORD_A, newUrl, 'rotated-pass-Q7', FROM_A, 'Accounts']) expect(everything, secret).not.toContain(secret);
  });

  it('makes no change and no audit record for a PATCH that sets what is already there', async () => {
    const made = await create({ name: 'Same' });
    const res = await call('PATCH', `/v1/email-senders/${made.id}`, { body: { name: 'Same' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await auditEvents(orgId, 'email_sender.saved', made.id)).toHaveLength(1);
    expect((await call('PATCH', `/v1/email-senders/${made.id}`, { body: {} })).statusCode).toBe(400);
  });

  it('refuses to delete a sender a notification sends from (409 EMAIL_SENDER_IN_USE), and deletes it and its secret once it is free', async () => {
    const made = await create();
    // A notification that sends from the sender, put in as the notification routes would (this file tests the sender routes).
    const notificationId = randomUUID();
    await owner.query(
      `insert into notifications (id, org_id, form_id, kind, trigger, sender_id, config, purpose_ids) values ($1, $2, $3, 'owner', 'submitted', $4, $5::jsonb, array['pur_1'])`,
      [notificationId, orgId, formId, made.id, JSON.stringify({ id: notificationId, name: 'Uses the sender' })],
    );
    const secretId = (await senderRow(made.id))!.smtp_secret_id;
    const blocked = await call('DELETE', `/v1/email-senders/${made.id}`);
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'EMAIL_SENDER_IN_USE' });
    expect(await senderRow(made.id)).toBeDefined();
    expect(await secretRow(secretId)).toBeDefined();

    await owner.query('delete from notifications where id = $1', [notificationId]);
    expect((await call('DELETE', `/v1/email-senders/${made.id}`)).statusCode).toBe(204);
    expect(await senderRow(made.id)).toBeUndefined();
    expect(await secretRow(secretId)).toBeUndefined();
    expect(await auditEvents(orgId, 'email_sender.deleted', made.id)).toEqual([expect.objectContaining({ actorId: user.owner, outcome: 'success' })]);
    expect((await call('DELETE', `/v1/email-senders/${made.id}`)).statusCode).toBe(404);
  });

  it('records email_sender.tested with the result and nothing else', async () => {
    const made = await create();
    mailer.reset();
    mailer.verifyResult = { ok: false, error: 'connection refused' };
    await call('POST', `/v1/email-senders/${made.id}/test`);
    mailer.reset();
    await call('POST', `/v1/email-senders/${made.id}/test`);
    const events = await auditEvents(orgId, 'email_sender.tested', made.id);
    expect(events.map((e) => e.metadata)).toEqual([{ ok: false, verified: false }, { ok: true, verified: true }]);
  });
});

describe('org isolation', () => {
  it('shows org B nothing of org A’s senders, and lets org B change, test and delete none', async () => {
    const made = await create({ name: 'Org A private mailbox 3c9f' });
    mailer.reset();
    const asB = (method: Method, url: string, body?: unknown) => call(method, url, { as: user.otherOwner, org: otherOrgId, body });
    for (const res of [await asB('PATCH', `/v1/email-senders/${made.id}`, { name: 'Org B was here', smtpUrl: 'smtp://attacker.test:25' }), await asB('DELETE', `/v1/email-senders/${made.id}`), await asB('POST', `/v1/email-senders/${made.id}/test`)]) {
      expect(res.statusCode, res.body).toBe(404);
    }
    // No mailer was made for a sender that is not org B's.
    expect(mailer.orgs).toEqual([]);
    const list = await asB('GET', '/v1/email-senders');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain('Org A private mailbox 3c9f');
    expect(list.body).not.toContain(FROM_A);
    expect((await senderRow(made.id))!.name).toBe('Org A private mailbox 3c9f');

    // Org B's own sender is org B's, whatever the caller sends; the secret row carries org B's id.
    const own = await asB('POST', '/v1/email-senders', { name: 'Org B mailbox', fromAddress: 'hello@sender-b.test', smtpUrl: 'smtp://relay.sender-b.test:25' });
    expect(own.statusCode, own.body).toBe(201);
    const ownRow = (await senderRow(own.json<Sender>().id))!;
    expect(ownRow.org_id).toBe(otherOrgId);
    expect((await secretRow(ownRow.smtp_secret_id))!.org_id).toBe(otherOrgId);
  });
});
