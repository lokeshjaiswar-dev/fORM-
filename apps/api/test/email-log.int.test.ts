import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { provision } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { createFileStore } from '../src/files.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

/*
 * WP-1.16 delivery log (NOT-04): `GET /v1/forms/:formId/email-log` shows who a form's emails went to, masked, to the members
 * who may read responses, page by page. The worker writes the rows (a member cannot), so these tests insert them as the
 * migrator does and read them back through the API. The cross-org case is also in the isolation suite.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const FULL_ADDRESS = 'priya.sharma@respondent-mail.example';
const MASKED = 'p***@respondent-mail.example';

interface LogItem {
  id: string;
  notificationId: string;
  submissionId: string;
  role: string;
  to: string[];
  status: string;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
}
interface Page {
  items: LogItem[];
  nextCursor: string | null;
}

let app: FastifyInstance;
let owner: pg.Pool;
let filesDir: string;
let orgId: string;
let otherOrgId: string;
let formId: string;
let emptyFormId: string;
let submissionId: string;
let notificationId: string;
let messageIds: string[];
/** The database's own clock when the rows were made: the monthly partitions exist for now and the months after it, not for a date we pick. */
let clock: string;
const user: Record<'owner' | 'editor' | 'creator' | 'dataViewer' | 'dataCollaborator' | 'viewer' | 'otherOwner', string> = {
  owner: randomUUID(),
  editor: randomUUID(),
  creator: randomUUID(),
  dataViewer: randomUUID(),
  dataCollaborator: randomUUID(),
  viewer: randomUUID(),
  otherOwner: randomUUID(),
};

const call = (url: string, o: { as?: string; org?: string } = {}) =>
  app.inject({ method: 'GET', url, headers: { 'x-fr-dev-user': o.as ?? user.owner, 'x-fr-org': o.org ?? orgId } });

const logUrl = (query = '', form = formId) => `/v1/forms/${form}/email-log${query}`;

/** One row of the log as the worker writes it (the log never holds a full address: `to_display_masked` is what it stores). */
async function insertMessage(o: { at: number; status?: string; attempts?: number; error?: string | null; sentAt?: number | null; to?: string[]; role?: string }): Promise<string> {
  const id = randomUUID();
  const { rows } = await owner.query<{ received_at: Date }>('select received_at from submissions where id = $1', [submissionId]);
  await owner.query(
    `insert into email_messages (id, created_at, org_id, form_id, submission_id, submission_received_at, notification_id, role, to_display_masked, subject_hash, message_id, status, attempts, last_error, sent_at)
     values ($1, $2::timestamptz + make_interval(secs => $16::float8), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz + make_interval(secs => $17::float8))`,
    [
      id,
      clock,
      orgId,
      formId,
      submissionId,
      rows[0]!.received_at,
      notificationId,
      o.role ?? 'to',
      o.to ?? [MASKED],
      createHash('sha256').update(id).digest(),
      `<${id}@form.test>`,
      o.status ?? 'sent',
      o.attempts ?? 1,
      o.error ?? null,
      o.sentAt == null ? null : clock,
      o.at,
      o.sentAt ?? 0,
    ],
  );
  return id;
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_email_log');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  filesDir = await mkdtemp(path.join(tmpdir(), 'fr-email-log-'));
  orgId = randomUUID();
  otherOrgId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2), ($3, $4, $4)', [orgId, 'log-a', otherOrgId, 'log-b']);
  const members: Array<[string, string, string]> = [
    [user.owner, 'owner', orgId],
    [user.editor, 'editor', orgId],
    [user.creator, 'creator', orgId],
    [user.dataViewer, 'data_viewer', orgId],
    [user.dataCollaborator, 'data_collaborator', orgId],
    [user.viewer, 'viewer', orgId],
    [user.otherOwner, 'owner', otherOrgId],
  ];
  for (const [id, role, org] of members) {
    await owner.query('insert into users (id, email, email_norm, name) values ($1, $2, $2, $3)', [id, `${role}-${id.slice(0, 8)}@log.test`, role]);
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
  app = await buildApp(parsed.config, { underPressure: false, files: createFileStore(filesDir) });

  // A published form with one response, the way they really arrive: the rows of the log point at it.
  const as = { 'x-fr-dev-user': user.owner, 'x-fr-org': orgId, ...BROWSER };
  const made = await app.inject({ method: 'POST', url: '/v1/forms', headers: as, payload: { title: 'Log form' } });
  formId = made.json<{ id: string }>().id;
  const saved = await app.inject({ method: 'PUT', url: `/v1/forms/${formId}/draft`, headers: { ...as, 'if-match': '0' }, payload: { draft: draftWith(formId, [fieldBlock('name', 'short_text')], 'Log form') } as never });
  expect(saved.statusCode, saved.body).toBe(200);
  const live = await app.inject({ method: 'POST', url: `/v1/forms/${formId}/publish`, headers: as, payload: {} });
  expect(live.statusCode, live.body).toBe(200);
  const { slug, versionId } = live.json<{ slug: string; versionId: string }>();
  const submitted = await app.inject({
    method: 'POST',
    url: `/v1/p/${slug}/submissions`,
    headers: { 'idempotency-key': randomUUID() },
    payload: { formVersionId: versionId, answers: { name: { type: 'short_text', value: 'Priya' } }, fields: [], locale: 'en-IN' } as never,
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
  submissionId = submitted.json<{ submissionId: string }>().submissionId;
  emptyFormId = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as, payload: { title: 'Empty log form' } })).json<{ id: string }>().id;
  notificationId = randomUUID();

  // Five messages, a second apart, the newest last; two share a created_at to the microsecond so the cursor must break the tie by id.
  clock = (await owner.query<{ t: string }>('select now()::text as t')).rows[0]!.t;
  messageIds = [
    await insertMessage({ at: 1, status: 'sent', sentAt: 2 }),
    await insertMessage({ at: 2, status: 'retrying', attempts: 2, error: 'Mailbox busy, try later' }),
    await insertMessage({ at: 3, status: 'failed', attempts: 5, error: 'Recipient address rejected', role: 'cc' }),
    await insertMessage({ at: 4, status: 'sent', sentAt: 5, to: [MASKED, 'a***@other.example'] }),
    await insertMessage({ at: 4, status: 'queued', attempts: 0 }),
  ];
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  if (filesDir) await rm(filesDir, { recursive: true, force: true });
});

describe('who may read the log (submissions.read)', () => {
  it('shows a data_viewer the masked recipients, status, attempts, error and times, and never a full address', async () => {
    const res = await call(logUrl(), { as: user.dataViewer });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json<Page>();
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
    const failed = page.items.find((i) => i.status === 'failed')!;
    expect(failed).toMatchObject({ role: 'cc', to: [MASKED], attempts: 5, lastError: 'Recipient address rejected', sentAt: null, notificationId, submissionId });
    const sent = page.items.find((i) => i.to.length === 2)!;
    expect(sent).toMatchObject({ status: 'sent', to: [MASKED, 'a***@other.example'] });
    expect(Date.parse(sent.sentAt!)).toBeGreaterThan(Date.parse(sent.createdAt));
    expect(res.body).not.toContain(FULL_ADDRESS);
    // The row names no column that could hold more than the mask, nor a body.
    expect(Object.keys(failed).sort()).toEqual(['attempts', 'createdAt', 'id', 'lastError', 'notificationId', 'role', 'sentAt', 'status', 'submissionId', 'to']);
  });

  it('gives a creator, who may not read responses, 403 and a request.authorize denied record', async () => {
    const res = await call(logUrl(), { as: user.creator });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(res.body).not.toContain(MASKED);
    const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'requestId' = $2`, [orgId, res.headers['x-request-id']]);
    expect(rows.map((r) => r.event)).toEqual([
      expect.objectContaining({ action: 'request.authorize', outcome: 'denied', actorId: user.creator, reason: 'missing_permission:submissions.read', resourceId: 'GET /v1/forms/:formId/email-log' }),
    ]);
  });

  it('lets everyone who has submissions.read in: owner, editor, data collaborator and viewer', async () => {
    for (const who of ['owner', 'editor', 'dataCollaborator', 'viewer', 'dataViewer'] as const) {
      const res = await call(logUrl(), { as: user[who] });
      expect(res.statusCode, `${who}: ${res.body}`).toBe(200);
      expect(res.json<Page>().items).toHaveLength(5);
    }
  });
});

describe('the pages', () => {
  it('lists newest first, in pages by a signed cursor, each message once, with a tie on created_at broken by id', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await call(logUrl(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<Page>();
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...messageIds].sort());
    // Newest first: the two rows made last share an instant (ordered by id, descending), then the older ones.
    const all = (await call(logUrl())).json<Page>().items;
    expect(all.map((i) => i.createdAt)).toEqual([...all.map((i) => i.createdAt)].sort().reverse());
    expect(seen).toEqual(all.map((i) => i.id));
    expect(all.slice(0, 2).map((i) => i.id)).toEqual([...messageIds.slice(3)].sort().reverse());
  });

  it('filters by status, and refuses a cursor that was edited, is for another filter, or is for another form', async () => {
    const failedOnly = (await call(logUrl('?status=failed'))).json<Page>();
    expect(failedOnly.items.map((i) => i.status)).toEqual(['failed']);
    expect((await call(logUrl('?status=bounced'))).statusCode).toBe(400);

    const first = (await call(logUrl('?limit=2'))).json<Page>();
    expect(first.nextCursor).not.toBeNull();
    const cursor = encodeURIComponent(first.nextCursor!);
    expect((await call(logUrl(`?limit=2&cursor=${cursor}`))).statusCode).toBe(200);
    for (const url of [
      logUrl(`?limit=2&cursor=${cursor.slice(0, -4)}AAAA`),
      logUrl(`?limit=2&status=sent&cursor=${cursor}`),
      logUrl(`?limit=2&cursor=${cursor}`, emptyFormId),
      logUrl('?cursor=c1.e30.abc'),
    ]) {
      const res = await call(url);
      expect(res.statusCode, `${url}: ${res.body}`).toBe(400);
      expect(res.json()).toMatchObject({ code: 'INVALID_CURSOR' });
    }
  });

  it('answers an empty log for a form that has sent nothing, and 404 for a form that is not in the org', async () => {
    const empty = await call(logUrl('', emptyFormId));
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ items: [], nextCursor: null });
    expect((await call(logUrl('', randomUUID()))).statusCode).toBe(404);
    expect((await call('/v1/forms/not-a-uuid/email-log')).statusCode).toBe(400);
  });
});

describe('org isolation', () => {
  it('shows org B nothing of org A’s log: the form is 404 and org B’s own log is empty', async () => {
    const res = await call(logUrl(), { as: user.otherOwner, org: otherOrgId });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.body).not.toContain(MASKED);
    const ownForm = (
      await app.inject({ method: 'POST', url: '/v1/forms', headers: { 'x-fr-dev-user': user.otherOwner, 'x-fr-org': otherOrgId, ...BROWSER }, payload: { title: 'Org B form' } })
    ).json<{ id: string }>().id;
    const own = await call(logUrl('', ownForm), { as: user.otherOwner, org: otherOrgId });
    expect(own.json()).toEqual({ items: [], nextCursor: null });
  });
});
