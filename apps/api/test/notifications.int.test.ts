import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createKeyfileKeyProvider, createOrgSecrets } from '@form/adapters/kms';
import { provision } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

/*
 * WP-1.16 notifications: what a form's emails may name (the draft's purposes, the org's senders and members), who may
 * route answers to whom (`data.route`), the revision check, the warnings for fields the form no longer has, the audit
 * record and org isolation. The cross-org cases of every route are also in the isolation suite
 * (isolation-cases/notifications.ts); this file proves the behaviour inside one org.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const EXTERNAL = 'accounts-desk-77@partner.example';
const SUBJECT_TEXT = 'Subject text that must stay out of the audit trail 5e1a';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
interface Warning {
  code: string;
  path: string;
  blockId: string;
  message: string;
}
interface View {
  id: string;
  formId: string;
  rev: number;
  config: Record<string, unknown>;
  warnings: Warning[];
}

let app: FastifyInstance;
let owner: pg.Pool;
let orgId: string;
let otherOrgId: string;
let formId: string;
let otherFormId: string;
let otherOrgFormId: string;
const user: Record<'owner' | 'admin' | 'editor' | 'creator' | 'creator2' | 'dataViewer' | 'viewer' | 'suspendedEditor' | 'otherOwner', string> = {
  owner: randomUUID(),
  admin: randomUUID(),
  editor: randomUUID(),
  creator: randomUUID(),
  creator2: randomUUID(),
  dataViewer: randomUUID(),
  viewer: randomUUID(),
  suspendedEditor: randomUUID(),
  otherOwner: randomUUID(),
};

const call = (method: Method, url: string, o: { as?: string | undefined; org?: string | undefined; body?: unknown; ifMatch?: string | number | undefined } = {}) =>
  app.inject({
    method,
    url,
    headers: { 'x-fr-dev-user': o.as ?? user.owner, 'x-fr-org': o.org ?? orgId, ...BROWSER, ...(o.ifMatch === undefined ? {} : { 'if-match': String(o.ifMatch) }) },
    ...(o.body === undefined ? {} : { payload: o.body as Record<string, unknown> }),
  });

/** A form with the two text fields below and two declared purposes, saved as the org owner's first draft. */
async function newForm(orgForOwner: string, as: string, title: string, o: { secondPurpose?: boolean } = {}): Promise<string> {
  const created = await call('POST', '/v1/forms', { as, org: orgForOwner, body: { title } });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json<{ id: string }>().id;
  const draft = draftWith(id, [fieldBlock('name', 'short_text', {}, { required: true }), fieldBlock('email', 'email')], title);
  const purposes = draft.privacy.purposes;
  const withPurposes = o.secondPurpose ? { ...draft, privacy: { ...draft.privacy, purposes: [...purposes, { ...purposes[0]!, id: 'pur_2', name: 'Newsletter' }] } } : draft;
  const saved = await call('PUT', `/v1/forms/${id}/draft`, { as, org: orgForOwner, ifMatch: 0, body: { draft: withPurposes } });
  expect(saved.statusCode, saved.body).toBe(200);
  return id;
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_notifications');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  orgId = randomUUID();
  otherOrgId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2), ($3, $4, $4)', [orgId, 'notify-a', otherOrgId, 'notify-b']);
  const members: Array<[string, string, string, string]> = [
    [user.owner, 'owner', orgId, 'active'],
    [user.admin, 'admin', orgId, 'active'],
    [user.editor, 'editor', orgId, 'active'],
    [user.creator, 'creator', orgId, 'active'],
    [user.creator2, 'creator', orgId, 'active'],
    [user.dataViewer, 'data_viewer', orgId, 'active'],
    [user.viewer, 'viewer', orgId, 'active'],
    [user.suspendedEditor, 'editor', orgId, 'suspended'],
    [user.otherOwner, 'owner', otherOrgId, 'active'],
  ];
  for (const [id, role, org, status] of members) {
    await owner.query('insert into users (id, email, email_norm, name) values ($1, $2, $2, $3)', [id, `${role}-${id.slice(0, 8)}@notify.test`, role]);
    await owner.query('insert into memberships (org_id, user_id, role, status) values ($1, $2, $3, $4)', [org, id, role, status]);
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
  app = await buildApp(parsed.config, { underPressure: false, keys, orgSecrets: createOrgSecrets(keys) });
  formId = await newForm(orgId, user.owner, 'Notify form', { secondPurpose: true });
  otherFormId = await newForm(orgId, user.owner, 'Second form');
  otherOrgFormId = await newForm(otherOrgId, user.otherOwner, 'Other org form');
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
});

const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (t: string) => ({ type: 'text', text: t });
const doc = (...content: unknown[]) => ({ type: 'email_doc', content });

/** A notification that is valid for `formId` (declares `pur_1`, names no outside recipient); `over` replaces keys. */
function notif(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'New response',
    kind: 'owner',
    enabled: true,
    trigger: 'submitted',
    to: [{ kind: 'role', role: 'org_admins' }],
    purposeIds: ['pur_1'],
    subject: [SUBJECT_TEXT],
    body: doc(para(text('A new response arrived.'))),
    locale: 'respondent',
    includeWithdrawalLink: false,
    ...over,
  };
}

const base = (f: string = formId) => `/v1/forms/${f}/notifications`;

async function create(over: Record<string, unknown> = {}, o: { as?: string; form?: string } = {}): Promise<View> {
  const res = await call('POST', base(o.form), { as: o.as, body: notif(over) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<View>();
}

/** The audit events of an action in an org's pending log, oldest first (the chain worker does not run in these tests). */
async function auditEvents(orgKey: string, action: string, resourceId?: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `select event from audit_pending where org_key = $1 and event->>'action' = $2 and ($3::text is null or event->>'resourceId' = $3) order by id`,
    [orgKey, action, resourceId ?? null],
  );
  return rows.map((r) => r.event);
}

const rowOf = async (id: string) =>
  (await owner.query<{ kind: string; trigger: string; enabled: boolean; sender_id: string | null; purpose_ids: string[]; rev: number; config: Record<string, unknown> }>('select * from notifications where id = $1', [id])).rows[0];
const countFor = async (form: string) => (await owner.query<{ n: number }>('select count(*)::int as n from notifications where form_id = $1', [form])).rows[0]!.n;

describe('purposes (WP-1.16: a notification names the purposes it may send)', () => {
  it('refuses an empty purposeIds and an unknown purpose with 422 MISSING_PURPOSE, and writes nothing', async () => {
    const before = await countFor(formId);
    for (const purposeIds of [[], ['pur_does_not_exist'], ['pur_1', 'pur_nope']]) {
      const res = await call('POST', base(), { body: notif({ purposeIds }) });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json()).toMatchObject({ code: 'MISSING_PURPOSE' });
    }
    expect(await countFor(formId)).toBe(before);
  });

  it('refuses a purpose of another form’s draft: only the draft of this form counts', async () => {
    // `otherFormId` declares only pur_1, so pur_2 (declared by `formId`) is unknown there.
    const res = await call('POST', base(otherFormId), { body: notif({ purposeIds: ['pur_2'] }) });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({ code: 'MISSING_PURPOSE' });
  });

  it('saves a declared purpose: 201 on create and 200 on save, with purpose_ids set on the row, and the same purpose twice once', async () => {
    const made = await create({ purposeIds: ['pur_1', 'pur_1'] });
    expect(made.config).toMatchObject({ purposeIds: ['pur_1'] });
    expect((await rowOf(made.id))!.purpose_ids).toEqual(['pur_1']);
    const saved = await call('PUT', `${base()}/${made.id}`, { ifMatch: made.rev, body: notif({ purposeIds: ['pur_2', 'pur_1'] }) });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await rowOf(made.id))!.purpose_ids).toEqual(['pur_2', 'pur_1']);
  });

  it('refuses a PUT that empties the purposes and keeps the stored ones', async () => {
    const made = await create();
    const res = await call('PUT', `${base()}/${made.id}`, { ifMatch: made.rev, body: notif({ purposeIds: [] }) });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'MISSING_PURPOSE' });
    expect(await rowOf(made.id)).toMatchObject({ purpose_ids: ['pur_1'], rev: 1 });
  });
});

describe('the body', () => {
  it('copies kind, trigger, enabled and the id into the columns and the config, and ignores an id the client chose', async () => {
    const chosen = randomUUID();
    const res = await call('POST', base(), { body: notif({ id: chosen, kind: 'autoresponder', trigger: 'edited', enabled: false, to: [{ kind: 'field', blockId: 'email' }] }) });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json<View>();
    expect(view.id).not.toBe(chosen);
    expect(view.config).toMatchObject({ id: view.id, kind: 'autoresponder', trigger: 'edited', enabled: false });
    expect(res.headers.etag).toBe('"1"');
    expect(await rowOf(view.id)).toMatchObject({ kind: 'autoresponder', trigger: 'edited', enabled: false, rev: 1, sender_id: null });
    expect(await rowOf(chosen)).toBeUndefined();
  });

  it('refuses a body the strict twin does not accept (an unknown key, a missing field) with 422 NOTIFICATION_INVALID and paths', async () => {
    const extra = await call('POST', base(), { body: notif({ passwordHash: 'x' }) });
    expect(extra.statusCode).toBe(422);
    expect(extra.json()).toMatchObject({ code: 'NOTIFICATION_INVALID' });
    const { name: _name, ...noName } = notif();
    const missing = await call('POST', base(), { body: noName });
    expect(missing.statusCode).toBe(422);
    expect(missing.json<{ errors: Array<{ path: string }> }>().errors.map((e) => e.path)).toContain('/name');
  });

  it('refuses a PUT whose body names another id than the address', async () => {
    const made = await create();
    const res = await call('PUT', `${base()}/${made.id}`, { ifMatch: made.rev, body: notif({ id: randomUUID() }) });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ errors: Array<{ path: string }> }>().errors.map((e) => e.path)).toEqual(['/id']);
  });

  it('answers a notification of another form of the same org with 404 (the address names the form)', async () => {
    const made = await create();
    expect((await call('GET', `${base(otherFormId)}/${made.id}`)).statusCode).toBe(404);
    expect((await call('PUT', `${base(otherFormId)}/${made.id}`, { ifMatch: made.rev, body: notif() })).statusCode).toBe(404);
    expect((await call('DELETE', `${base(otherFormId)}/${made.id}`)).statusCode).toBe(404);
    expect((await rowOf(made.id))!.rev).toBe(1);
  });

  it('stops at 25 notifications per form', async () => {
    const form = await newForm(orgId, user.owner, 'Full form');
    for (let i = 0; i < 25; i += 1) await create({ name: `Email ${i}` }, { form });
    const res = await call('POST', base(form), { body: notif({ name: 'One too many' }) });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
    expect(await countFor(form)).toBe(25);
  });
});

describe('who may route answers to whom (data.route)', () => {
  it('refuses a creator a fixed external address with 403 and a request.authorize denied record, and an editor may', async () => {
    const before = await countFor(formId);
    const res = await call('POST', base(), { as: user.creator, body: notif({ to: [{ kind: 'email', address: EXTERNAL }] }) });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: 'DATA_ROUTE_FORBIDDEN' });
    // The refusal names the place in the notification, never the address.
    expect(res.body).not.toContain(EXTERNAL);
    expect(await countFor(formId)).toBe(before);
    const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'requestId' = $2`, [orgId, res.headers['x-request-id']]);
    expect(rows.map((r) => r.event)).toEqual([
      expect.objectContaining({ action: 'request.authorize', outcome: 'denied', actorId: user.creator, reason: 'missing_permission:data.route', resourceId: `POST /v1/forms/:formId/notifications` }),
    ]);

    const made = await call('POST', base(), { as: user.editor, body: notif({ to: [{ kind: 'email', address: EXTERNAL }] }) });
    expect(made.statusCode, made.body).toBe(201);
    expect(await countFor(formId)).toBe(before + 1);
  });

  it('lets a creator name an org member who may read answers, the org’s admins and a field the respondent fills in: none is an outside recipient', async () => {
    const asMember = await call('POST', base(), { as: user.creator, body: notif({ to: [{ kind: 'member', userId: user.dataViewer }, { kind: 'member', userId: user.admin }] }) });
    expect(asMember.statusCode, asMember.body).toBe(201);
    const asRole = await call('POST', base(), { as: user.creator, body: notif({ to: [{ kind: 'role', role: 'org_admins' }], cc: [{ kind: 'role', role: 'team_admins' }] }) });
    expect(asRole.statusCode, asRole.body).toBe(201);
    const auto = await call('POST', base(), { as: user.creator, body: notif({ kind: 'autoresponder', to: [{ kind: 'field', blockId: 'email' }] }) });
    expect(auto.statusCode, auto.body).toBe(201);
  });

  it('refuses a creator a member whose role cannot read answers (another creator, a suspended editor), and an editor may', async () => {
    for (const userId of [user.creator2, user.suspendedEditor]) {
      const res = await call('POST', base(), { as: user.creator, body: notif({ bcc: [{ kind: 'member', userId }] }) });
      expect(res.statusCode, `${userId}: ${res.body}`).toBe(403);
      expect(res.json()).toMatchObject({ code: 'DATA_ROUTE_FORBIDDEN' });
      expect((await call('POST', base(), { as: user.editor, body: notif({ bcc: [{ kind: 'member', userId }] }) })).statusCode).toBe(201);
    }
  });

  it('treats the form’s owner as outside when their role cannot read answers', async () => {
    const form = await newForm(orgId, user.creator, 'Creator’s form');
    const asCreator = await call('POST', base(form), { as: user.creator, body: notif({ to: [{ kind: 'role', role: 'form_owner' }] }) });
    expect(asCreator.statusCode, asCreator.body).toBe(403);
    expect((await call('POST', base(form), { as: user.editor, body: notif({ to: [{ kind: 'role', role: 'form_owner' }] }) })).statusCode).toBe(201);
    // The owner of `formId` is the org owner, who can read answers.
    expect((await call('POST', base(), { as: user.creator, body: notif({ to: [{ kind: 'role', role: 'form_owner' }] }) })).statusCode).toBe(201);
  });

  it('refuses a member that is not in this org (another org’s user looks like one that does not exist) with 422 RECIPIENT_NOT_FOUND', async () => {
    for (const userId of [user.otherOwner, randomUUID(), 'not-a-uuid']) {
      const res = await call('POST', base(), { body: notif({ to: [{ kind: 'member', userId }] }) });
      expect(res.statusCode, `${userId}: ${res.body}`).toBe(422);
      expect(res.json()).toMatchObject({ code: 'RECIPIENT_NOT_FOUND' });
    }
  });

  it('lets a creator change what an editor set up without routing anything new, and refuses what would', async () => {
    const mine = await create({ to: [{ kind: 'email', address: EXTERNAL }, { kind: 'role', role: 'org_admins' }] }, { as: user.editor });
    const put = (as: string, rev: number, over: Record<string, unknown>) => call('PUT', `${base()}/${mine.id}`, { as, ifMatch: rev, body: notif({ to: mine.config.to, ...over }) });

    // Subject, text and a narrower recipient list route nothing the notification did not already.
    const edited = await put(user.creator, mine.rev, { subject: ['A better subject'], body: doc(para(text('New words.'))) });
    expect(edited.statusCode, edited.body).toBe(200);
    const fewer = await put(user.creator, edited.json<View>().rev, { to: [{ kind: 'email', address: EXTERNAL }] });
    expect(fewer.statusCode, fewer.body).toBe(200);
    const rev = fewer.json<View>().rev;

    // A second outside address, more purposes for the one that is there, and the respondent's files each need data.route.
    const another = await put(user.creator, rev, { to: [{ kind: 'email', address: EXTERNAL }, { kind: 'email', address: 'someone-else@partner.example' }] });
    expect(another.statusCode, another.body).toBe(403);
    const wider = await put(user.creator, rev, { to: [{ kind: 'email', address: EXTERNAL }], purposeIds: ['pur_1', 'pur_2'] });
    expect(wider.statusCode, wider.body).toBe(403);
    const files = await put(user.creator, rev, { to: [{ kind: 'email', address: EXTERNAL }], attachments: { uploads: 'attach' } });
    expect(files.statusCode, files.body).toBe(403);
    expect(await rowOf(mine.id)).toMatchObject({ rev });

    // Disabling stops routing, so it needs only forms.edit; an editor can do all of the above.
    const off = await put(user.creator, rev, { to: [{ kind: 'email', address: EXTERNAL }], enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    const wide = await put(user.editor, off.json<View>().rev, { to: [{ kind: 'email', address: EXTERNAL }], purposeIds: ['pur_1', 'pur_2'], attachments: { uploads: 'links' } });
    expect(wide.statusCode, wide.body).toBe(200);
    // Narrowing the purposes and dropping the files is free again.
    const narrow = await put(user.creator, wide.json<View>().rev, { to: [{ kind: 'email', address: EXTERNAL }], purposeIds: ['pur_1'] });
    expect(narrow.statusCode, narrow.body).toBe(200);
  });

  it('lets a creator delete a notification with an outside recipient: removing one routes nothing', async () => {
    const mine = await create({ to: [{ kind: 'email', address: EXTERNAL }] }, { as: user.editor });
    expect((await call('DELETE', `${base()}/${mine.id}`, { as: user.creator })).statusCode).toBe(204);
    expect(await rowOf(mine.id)).toBeUndefined();
  });
});

describe('permissions', () => {
  it('lets forms.read read and forms.edit write: a viewer lists but cannot create, save or delete', async () => {
    const made = await create();
    expect((await call('GET', base(), { as: user.viewer })).statusCode).toBe(200);
    expect((await call('GET', `${base()}/${made.id}`, { as: user.viewer })).statusCode).toBe(200);
    for (const [method, url, body] of [
      ['POST', base(), notif()],
      ['PUT', `${base()}/${made.id}`, notif()],
      ['DELETE', `${base()}/${made.id}`, undefined],
    ] as const) {
      const res = await call(method, url, { as: user.viewer, body, ifMatch: made.rev });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403);
      const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'requestId' = $2`, [orgId, res.headers['x-request-id']]);
      expect(rows.map((r) => r.event)).toEqual([expect.objectContaining({ action: 'request.authorize', outcome: 'denied', actorId: user.viewer, reason: 'missing_permission:forms.edit' })]);
    }
    expect((await rowOf(made.id))!.rev).toBe(1);
  });
});

describe('the revision (If-Match)', () => {
  it('answers a stale revision with 409 NOTIFICATION_REV_CONFLICT and a save without one with 428, and bumps the revision on each save', async () => {
    const made = await create();
    const first = await call('PUT', `${base()}/${made.id}`, { ifMatch: made.rev, body: notif({ name: 'Renamed once' }) });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<View>().rev).toBe(2);
    expect(first.headers.etag).toBe('"2"');

    const stale = await call('PUT', `${base()}/${made.id}`, { ifMatch: made.rev, body: notif({ name: 'Renamed twice' }) });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'NOTIFICATION_REV_CONFLICT' });
    const none = await call('PUT', `${base()}/${made.id}`, { body: notif({ name: 'No revision' }) });
    expect(none.statusCode).toBe(428);
    expect(none.json()).toMatchObject({ code: 'NOTIFICATION_REV_REQUIRED' });
    expect((await rowOf(made.id))!.config).toMatchObject({ name: 'Renamed once' });

    // W/"2" and "2" name the revision too.
    expect((await call('PUT', `${base()}/${made.id}`, { ifMatch: 'W/"2"', body: notif({ name: 'Weak tag' }) })).statusCode).toBe(200);
  });

  it('lets exactly one of two saves from the same revision win', async () => {
    const made = await create();
    const results = await Promise.all(
      ['A', 'B', 'C'].map((name) => call('PUT', `${base()}/${made.id}`, { ifMatch: made.rev, body: notif({ name }) })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect((await rowOf(made.id))!.rev).toBe(2);
  });
});

describe('senders', () => {
  it('needs senderId to be one of the org’s email senders (422 SENDER_NOT_FOUND), and sets sender_id when it is', async () => {
    const mine = await call('POST', '/v1/email-senders', { body: { name: 'Org mailbox', fromAddress: 'hello@notify-a.test', smtpUrl: 'smtp://relay.notify-a.test:25' } });
    expect(mine.statusCode, mine.body).toBe(201);
    const theirs = await call('POST', '/v1/email-senders', { as: user.otherOwner, org: otherOrgId, body: { name: 'Other org', fromAddress: 'hello@notify-b.test', smtpUrl: 'smtp://relay.notify-b.test:25' } });
    expect(theirs.statusCode, theirs.body).toBe(201);
    for (const senderId of [theirs.json<{ id: string }>().id, randomUUID(), 'not-a-uuid']) {
      const res = await call('POST', base(), { body: notif({ senderId }) });
      expect(res.statusCode, `${senderId}: ${res.body}`).toBe(422);
      expect(res.json()).toMatchObject({ code: 'SENDER_NOT_FOUND' });
    }
    const made = await create({ senderId: mine.json<{ id: string }>().id });
    expect((await rowOf(made.id))!.sender_id).toBe(mine.json<{ id: string }>().id);
    expect(made.config).toMatchObject({ senderId: mine.json<{ id: string }>().id });
    // Taking the sender out clears the column too.
    const { senderId: _gone, ...without } = notif();
    const cleared = await call('PUT', `${base()}/${made.id}`, { ifMatch: made.rev, body: without });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await rowOf(made.id))!.sender_id).toBeNull();
  });
});

describe('warnings', () => {
  it('saves a notification that names a field the form does not have, and lists each one in warnings', async () => {
    const gone = 'blk_gone_7';
    const res = await call('POST', base(), {
      body: notif({
        kind: 'autoresponder',
        to: [{ kind: 'field', blockId: gone }, { kind: 'field', blockId: 'email' }],
        replyTo: { kind: 'field', blockId: 'blk_gone_reply' },
        subject: ['Thanks ', { pipe: { source: { kind: 'answer', blockId: 'name' } } }, { pipe: { source: { kind: 'answer', blockId: 'blk_gone_subject' } } }],
        body: doc(
          para(text('Hello '), { type: 'pipe', attrs: { source: { kind: 'answer', blockId: 'blk_gone_body' } } }),
          { type: 'answersTable', attrs: { include: ['name', 'blk_gone_table'], hideEmpty: true, maskSensitive: true } },
        ),
      }),
    });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json<View>();
    expect(view.warnings.map((w) => [w.code, w.blockId]).sort()).toEqual(
      [
        ['unknown_recipient_field', gone],
        ['unknown_recipient_field', 'blk_gone_reply'],
        ['unknown_merge_tag_block', 'blk_gone_subject'],
        ['unknown_merge_tag_block', 'blk_gone_body'],
        ['unknown_merge_tag_block', 'blk_gone_table'],
      ].sort(),
    );
    expect(view.warnings.find((w) => w.blockId === gone)).toMatchObject({ path: '/to/0' });
    // The row is saved as written, and a read computes the same warnings from the draft.
    expect((await rowOf(view.id))!.config).toMatchObject({ to: [{ kind: 'field', blockId: gone }, { kind: 'field', blockId: 'email' }] });
    const read = await call('GET', `${base()}/${view.id}`);
    expect(read.json<View>().warnings).toEqual(view.warnings);
    const list = await call('GET', base());
    expect(list.json<{ items: View[] }>().items.find((i) => i.id === view.id)!.warnings).toEqual(view.warnings);
  });

  it('has no warning for fields the draft has', async () => {
    const view = await create({ to: [{ kind: 'field', blockId: 'email' }], subject: [{ pipe: { source: { kind: 'answer', blockId: 'name' } } }] });
    expect(view.warnings).toEqual([]);
  });
});

describe('org isolation', () => {
  it('shows org B nothing of org A’s form or notifications, and lets org B change none', async () => {
    const made = await create({ name: 'Org A private 91c2' });
    const asB = (method: Method, url: string, body?: unknown, ifMatch?: number) => call(method, url, { as: user.otherOwner, org: otherOrgId, body, ...(ifMatch === undefined ? {} : { ifMatch }) });
    for (const res of [
      await asB('GET', base()),
      await asB('POST', base(), notif()),
      await asB('GET', `${base()}/${made.id}`),
      await asB('PUT', `${base()}/${made.id}`, notif({ name: 'Org B was here' }), made.rev),
      await asB('DELETE', `${base()}/${made.id}`),
      // Org B's own form with org A's notification id in the address.
      await asB('GET', `${base(otherOrgFormId)}/${made.id}`),
      await asB('PUT', `${base(otherOrgFormId)}/${made.id}`, notif({ name: 'Org B was here' }), made.rev),
    ]) {
      expect(res.statusCode, res.body).toBe(404);
      expect(res.body).not.toContain('Org A private 91c2');
    }
    expect(await rowOf(made.id)).toMatchObject({ rev: 1, config: expect.objectContaining({ name: 'Org A private 91c2' }) });
    // Org B's own list is its own.
    const own = await asB('GET', base(otherOrgFormId));
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({ items: [] });
  });
});

describe('audit', () => {
  it('records notification.saved and notification.deleted with keys and counts, never an address, a subject or a body', async () => {
    const made = await create({ to: [{ kind: 'email', address: EXTERNAL }], subject: [SUBJECT_TEXT] }, { as: user.editor });
    const saved = await call('PUT', `${base()}/${made.id}`, { as: user.editor, ifMatch: made.rev, body: notif({ to: [{ kind: 'email', address: EXTERNAL }], name: 'Renamed for audit', enabled: false, subject: ['Another subject'] }) });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await call('DELETE', `${base()}/${made.id}`, { as: user.editor })).statusCode).toBe(204);

    const events = await auditEvents(orgId, 'notification.saved', made.id);
    expect(events).toEqual([
      expect.objectContaining({
        actorId: user.editor,
        formId,
        outcome: 'success',
        metadata: expect.objectContaining({ change: 'created', kind: 'owner', trigger: 'submitted', rev: 1, recipientCount: 1, purposeCount: 1, externalRecipients: true }),
      }),
      expect.objectContaining({
        metadata: expect.objectContaining({ change: 'updated', rev: 2, enabled: false, changedKeys: ['enabled', 'name', 'subject'], externalRecipients: true }),
      }),
    ]);
    const deleted = await auditEvents(orgId, 'notification.deleted', made.id);
    expect(deleted).toEqual([expect.objectContaining({ actorId: user.editor, formId, metadata: { kind: 'owner', trigger: 'submitted' } })]);
    // Nothing a person wrote, nothing an answer could be, is in any of the three.
    const everything = JSON.stringify([...events, ...deleted]);
    for (const secret of [EXTERNAL, SUBJECT_TEXT, 'Another subject', 'Renamed for audit', 'A new response arrived.']) expect(everything).not.toContain(secret);
  });
});
