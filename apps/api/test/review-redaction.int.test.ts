import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPgBossQueue, installQueueSchema, parseJobKeyring, type PgBossQueue } from '@form/adapters/queue';
import { createPostgresSearchIndex } from '@form/adapters/search';
import { provision, uuidV7, uuidV7Time } from '@form/db';
import { DEFAULT_COMPLIANCE, REGISTRY } from '@form/registry';
import type { FormDefinition, Locale } from '@form/schema';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { createFileStore } from '../src/files.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

/*
 * WP-2.33 own_unit redaction in the responses API (grid, detail, file download, search) and the review summary of each
 * response. One form, two page units: the applicant's (name, qty, a CV file) is checked by group A and the notes
 * (note, rate, and `total` = qty x rate, which is worked out from the applicant's number) by group B, both `own_unit`.
 * The sentinel texts below must never reach a caller who may not read their unit: the tests read the whole body for them,
 * not only the keys they expect to find missing.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
/** More than any test sends from one address, so the throttle never speaks. */
const BUDGET = { max: 100_000, windowSeconds: 600 };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');

/** What only unit A holds, what only unit B holds, and what B's `total` is worked out from A's qty. */
const A_TEXTS = ['Asha Rao', 'cv.pdf'];
const B_TEXTS = ['Needs a ground floor room'];

let app: FastifyInstance;
let owner: pg.Pool;
let queue: PgBossQueue;
let dir: string;
let orgId: string;
let groupA: string;
let groupB: string;
let groupW: string;
/** Everyone is a member of the org; the groups they sit in decide what they see. */
const who = {
  owner: randomUUID(),
  /** An admin in no review group: sees everything. */
  admin: randomUUID(),
  checkerA: randomUUID(),
  checkerB: randomUUID(),
  /** An owner who also sits in group B: redacted like any checker of it. */
  ownerB: randomUUID(),
  /** An admin in group A. */
  adminA: randomUUID(),
  /** Sits in a group whose unit is `whole_submission` on the second form. */
  checkerW: randomUUID(),
};

const as = (user: string) => ({ 'x-fr-dev-user': user, 'x-fr-org': orgId, ...BROWSER });
const short = (value: string) => ({ type: 'short_text', value });
const num = (value: string) => ({ type: 'number', value });
const ref = (blockId: string) => ({ k: 'ref', ref: { kind: 'answer', blockId } });
const times = (left: string, right: string) => ({ k: 'binary', op: '*', left: ref(left), right: ref(right) });

interface Form {
  id: string;
  slug: string;
  versionId: string;
}

type Block = ReturnType<typeof fieldBlock>;

/** `qty x rate`, as a calculation block (`fieldBlock` takes only the types a respondent fills in). */
function calculation(id: string, expr: unknown): Block {
  const defaults = DEFAULT_COMPLIANCE.calculation;
  return {
    id,
    type: 'calculation',
    key: id,
    label: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: id }] }] },
    required: false,
    compliance: { ...defaults, purposeIds: defaults.classification === 'none' ? [] : ['pur_1'] },
    config: { ...REGISTRY.calculation.defaultConfig('en-IN' as Locale), expr, resultType: 'number', display: 'visible' },
  } as unknown as Block;
}

/** Page 1 is the applicant's unit; page 2 holds the notes, and a calculation worked out from the applicant's qty. */
function draftOf(formId: string, title: string): FormDefinition {
  const blocks = [
    fieldBlock('name', 'short_text'),
    fieldBlock('qty', 'number'),
    fieldBlock('cv', 'file_upload', { accept: { extensions: ['pdf'], mimeTypes: ['application/pdf'] } }),
    fieldBlock('note', 'short_text'),
    fieldBlock('rate', 'number'),
    calculation('total', times('qty', 'rate')),
  ];
  const base = draftWith(formId, blocks, title);
  return {
    ...base,
    pages: [
      { ...base.pages[0]!, children: ['name', 'qty', 'cv'] },
      { id: 'page_2', children: ['note', 'rate', 'total'] },
    ],
    review: {
      units: [
        { id: 'u_applicant', name: 'Applicant', target: { kind: 'page', pageId: 'page_1' } },
        { id: 'u_notes', name: 'Notes', target: { kind: 'page', pageId: 'page_2' } },
      ],
    },
  } as unknown as FormDefinition;
}

interface Assignment {
  unitId: string;
  groupId: string;
  order: number;
  required: boolean;
  visibility: 'own_unit' | 'whole_submission';
}

async function publishForm(title: string, units: (Assignment | ((g: { a: string; b: string; w: string }) => Assignment))[]): Promise<Form> {
  const { id } = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(who.owner), payload: { title } })).json<{ id: string }>();
  const put = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...as(who.owner), 'if-match': '0' }, payload: { draft: draftOf(id, title) } });
  expect(put.statusCode, put.body).toBe(200);
  const live = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(who.owner), payload: {} });
  expect(live.statusCode, live.body).toBe(200);
  const assigned = units.map((u) => (typeof u === 'function' ? u({ a: groupA, b: groupB, w: groupW }) : u));
  const review = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/review`, headers: { ...as(who.owner), 'if-match': '0' }, payload: { enabled: true, distinctCheckers: false, units: assigned } });
  expect(review.statusCode, review.body).toBe(200);
  return { id, ...live.json<{ slug: string; versionId: string }>() };
}

const unit = (unitId: string, groupId: string, visibility: Assignment['visibility'] = 'own_unit', order = 1): Assignment => ({ unitId, groupId, order, required: true, visibility });

async function upload(f: Form): Promise<{ fileId: string; name: string; sizeBytes: number; mime: string; sha256: string; scan: string }> {
  const res = await app.inject({ method: 'POST', url: `/v1/p/${f.slug}/files`, payload: { blockId: 'cv', name: 'cv.pdf', mime: 'application/pdf', data: PDF.toString('base64') } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** A respondent's submission with a CV; returns the response's id and the id of its file. */
async function submitOne(f: Form, o: { name?: string; note?: string } = {}): Promise<{ id: string; fileId: string }> {
  const file = await upload(f);
  const res = await app.inject({
    method: 'POST',
    url: `/v1/p/${f.slug}/submissions`,
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      formVersionId: f.versionId,
      answers: {
        name: short(o.name ?? 'Asha Rao'),
        qty: num('7'),
        cv: { type: 'file_upload', value: [file] },
        note: short(o.note ?? 'Needs a ground floor room'),
        rate: num('3'),
      },
      fields: [],
      locale: 'en-IN',
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json()).toMatchObject({ held: 'pending_review' });
  return { id: res.json<{ submissionId: string }>().submissionId, fileId: file.fileId };
}

interface Detail {
  id: string;
  status: string;
  fields: Array<{ id: string; value: string }>;
  answers: Record<string, unknown>;
  files: Array<{ id: string | null; blockId: string; name: string }>;
  review?: Array<{ name: string; state: string }>;
}
interface GridBody {
  columns: Array<{ id: string }>;
  items: Array<{ id: string; status: string; cells: Record<string, string>; masked: string[]; review?: Array<{ name: string; state: string }> }>;
  nextCursor: string | null;
}

const detail = (f: Form, id: string, user: string) => app.inject({ url: `/v1/forms/${f.id}/submissions/${id}`, headers: as(user) });
const grid = (f: Form, user: string, query = '') => app.inject({ url: `/v1/forms/${f.id}/submissions${query ? `?${query}` : ''}`, headers: as(user) });
const download = (f: Form, fileId: string, user: string) => app.inject({ url: `/v1/forms/${f.id}/files/${fileId}`, headers: as(user) });

/** The audit events a request left (`audit_pending` holds them until `audit.chain` runs, which these tests do not start). */
async function auditOf(res: { headers: Record<string, unknown> }, action: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'requestId' = $2 and event->>'action' = $3 order by id`, [
    orgId,
    String(res.headers['x-request-id']),
    action,
  ]);
  return rows.map((r) => r.event);
}

/** A response stored as the schema owner with the given status and no review rows: a response of a form that was not reviewed, or one set aside. */
async function storePlain(f: Form, status: string): Promise<string> {
  const id = uuidV7(new Date());
  await owner.query(
    `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta)
     select $1, $2, org_id, form_id, id, decode(content_hash, 'hex'), 0, $3, $4, '{}', '{"locale":"en-IN"}' from form_versions where id = $5`,
    [id, uuidV7Time(id), status, JSON.stringify({ name: short('Plain Person'), note: short('Plain note') }), f.versionId],
  );
  return id;
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_review_redaction');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  await installQueueSchema({ connectionString: urls.fr_migrator, appRole: 'fr_app' });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  dir = await mkdtemp(path.join(tmpdir(), 'fr-review-redaction-'));
  orgId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'review-redaction']);
  const roles: Array<[keyof typeof who, string]> = [
    ['owner', 'owner'],
    ['admin', 'admin'],
    ['checkerA', 'editor'],
    ['checkerB', 'editor'],
    ['ownerB', 'owner'],
    ['adminA', 'admin'],
    ['checkerW', 'editor'],
  ];
  for (const [key, role] of roles) {
    await owner.query('insert into users (id, email, email_norm, email_verified_at) values ($1, $2, $2, now())', [who[key], `${key}@review-redaction.test`]);
    await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, who[key], role]);
  }
  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  const keyring = parseJobKeyring(`t1:${Buffer.alloc(32, 7).toString('base64url')}`);
  queue = createPgBossQueue({ connectionString: urls.fr_app, keyring, mode: 'producer', max: 2, applicationName: 'fr-api-review-redaction-test' });
  await queue.start();
  app = await buildApp(parsed.config, {
    underPressure: false,
    files: createFileStore(dir),
    searchIndex: createPostgresSearchIndex,
    queue,
    authLimits: { auth_submit_ip: BUDGET, auth_submit_form: BUDGET, auth_files_ip: BUDGET, auth_files_form: BUDGET },
  });
  const made: Record<string, string> = {};
  for (const name of ['Group A', 'Group B', 'Group W']) {
    const res = await app.inject({ method: 'POST', url: '/v1/org/review-groups', headers: as(who.owner), payload: { name } });
    expect(res.statusCode, res.body).toBe(201);
    made[name] = res.json<{ id: string }>().id;
  }
  groupA = made['Group A']!;
  groupB = made['Group B']!;
  groupW = made['Group W']!;
  const members: Array<[string, string]> = [
    [groupA, who.checkerA],
    [groupA, who.adminA],
    [groupB, who.checkerB],
    [groupB, who.ownerB],
    [groupW, who.checkerW],
  ];
  for (const [group, user] of members) {
    const res = await app.inject({ method: 'PUT', url: `/v1/org/review-groups/${group}/members/${user}`, headers: as(who.owner) });
    expect(res.statusCode, res.body).toBe(200);
  }
});

afterAll(async () => {
  await app?.close();
  await queue?.stop({ graceMs: 1000 });
  await owner?.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const everything = ['cv', 'name', 'note', 'qty', 'rate', 'total'];

describe('the detail of a held response, with own_unit', () => {
  let form: Form;
  let sub: { id: string; fileId: string };
  beforeAll(async () => {
    form = await publishForm('Detail redaction', [unit('u_applicant', groupA), unit('u_notes', groupB, 'own_unit', 2)]);
    sub = await submitOne(form);
  });

  it('holds no unit-A answer, display row or file for a unit-B checker, and nothing derived from unit A', async () => {
    const res = await detail(form, sub.id, who.checkerB);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Detail>();
    // `total` sits in unit B but is qty x rate, and qty is the applicant's: it would carry unit A's answer to a unit-B checker.
    expect(Object.keys(body.answers).sort()).toEqual(['note', 'rate']);
    expect(body.fields.map((f) => f.id).sort()).toEqual(['note', 'rate']);
    expect(body.fields.find((f) => f.id === 'note')?.value).toBe('Needs a ground floor room');
    expect(body.files).toEqual([]);
    const text = res.body;
    for (const secret of A_TEXTS) expect(text, secret).not.toContain(secret);
    expect(text).not.toContain(sub.fileId);
    // The summary names every unit and its state, to everyone.
    expect(body.review).toEqual([
      { name: 'Applicant', state: 'pending' },
      { name: 'Notes', state: 'pending' },
    ]);
    expect(body.status).toBe('pending_review');
  });

  it('is the same the other way round for a unit-A checker, and for an owner or admin who sits in a group', async () => {
    for (const user of [who.checkerA, who.adminA]) {
      const res = await detail(form, sub.id, user);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<Detail>();
      expect(Object.keys(body.answers).sort(), user).toEqual(['cv', 'name', 'qty']);
      expect(body.fields.map((f) => f.id).sort()).toEqual(['cv', 'name', 'qty']);
      expect(body.files.map((f) => [f.blockId, f.name, f.id])).toEqual([['cv', 'cv.pdf', sub.fileId]]);
      for (const secret of B_TEXTS) expect(res.body, secret).not.toContain(secret);
    }
    // An owner in group B is redacted as much as an editor: the role does not lift it.
    const boss = await detail(form, sub.id, who.ownerB);
    expect(Object.keys(boss.json<Detail>().answers).sort()).toEqual(['note', 'rate']);
    expect(boss.body).not.toContain('Asha Rao');
  });

  it('shows the whole response to a member in no review group, owners and admins included', async () => {
    for (const user of [who.owner, who.admin]) {
      const res = await detail(form, sub.id, user);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<Detail>();
      expect(Object.keys(body.answers).sort(), user).toEqual(everything);
      expect(body.fields.map((f) => f.id).sort()).toEqual(everything);
      expect(body.files.map((f) => f.blockId)).toEqual(['cv']);
      expect(body.fields.find((f) => f.id === 'total')?.value).toBe('21');
    }
  });

  it('is audited as ever: one submission.viewed record per read, redacted or not', async () => {
    for (const user of [who.checkerB, who.owner]) {
      const res = await detail(form, sub.id, user);
      const records = await auditOf(res, 'submission.viewed');
      expect(records, user).toHaveLength(1);
      expect(records[0]).toMatchObject({ actorId: user, resourceType: 'submission', resourceId: sub.id, formId: form.id, outcome: 'success' });
    }
  });

  it('answers 404, as before, for a response that is not on the form, and nothing of another org', async () => {
    expect((await detail(form, randomUUID(), who.checkerB)).statusCode).toBe(404);
  });
});

describe('the grid, with own_unit', () => {
  let form: Form;
  let sub: { id: string; fileId: string };
  beforeAll(async () => {
    form = await publishForm('Grid redaction', [unit('u_applicant', groupA), unit('u_notes', groupB, 'own_unit', 2)]);
    sub = await submitOne(form);
  });

  it('holds no unit-A cell, column or mask entry for a unit-B checker', async () => {
    const res = await grid(form, who.checkerB);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<GridBody>();
    expect(body.items.map((i) => i.id)).toEqual([sub.id]);
    expect(Object.keys(body.items[0]!.cells).sort()).toEqual(['note', 'rate']);
    expect(body.columns.map((c) => c.id).sort()).toEqual(['note', 'rate']);
    for (const secret of A_TEXTS) expect(res.body, secret).not.toContain(secret);
    expect(body.items[0]!.review).toEqual([
      { name: 'Applicant', state: 'pending' },
      { name: 'Notes', state: 'pending' },
    ]);
  });

  it('is cut the same way for a unit-A checker and an owner in the group of unit B', async () => {
    const a = (await grid(form, who.checkerA)).json<GridBody>();
    expect(Object.keys(a.items[0]!.cells).sort()).toEqual(['cv', 'name', 'qty']);
    expect(a.columns.map((c) => c.id).sort()).toEqual(['cv', 'name', 'qty']);
    const boss = await grid(form, who.ownerB);
    expect(Object.keys(boss.json<GridBody>().items[0]!.cells).sort()).toEqual(['note', 'rate']);
  });

  it('refuses q with 403 SEARCH_NOT_ALLOWED_FOR_REVIEWER, audited as denied, while the owner finds the response by the same words', async () => {
    const refused = await grid(form, who.checkerB, 'q=ground');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'SEARCH_NOT_ALLOWED_FOR_REVIEWER', status: 403 });
    // A search for the other unit's text is refused the same way: the refusal does not depend on what would have matched.
    expect((await grid(form, who.checkerB, 'q=Asha')).statusCode).toBe(403);
    const denied = await auditOf(refused, 'request.authorize');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ outcome: 'denied', actorId: who.checkerB, reason: 'search_not_allowed_for_reviewer' });
    // Nothing was read, so no page was recorded as viewed.
    expect(await auditOf(refused, 'submission.page_viewed')).toEqual([]);
    // An empty search box is no search.
    expect((await grid(form, who.checkerB, 'q=')).statusCode).toBe(200);

    const found = await grid(form, who.owner, 'q=ground');
    expect(found.statusCode, found.body).toBe(200);
    expect(found.json<GridBody>().items.map((i) => i.id)).toEqual([sub.id]);
  });

  it('shows every cell and column to a member in no review group, owners and admins included, and keeps the page audit', async () => {
    for (const user of [who.owner, who.admin]) {
      const res = await grid(form, user);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<GridBody>();
      expect(Object.keys(body.items[0]!.cells).sort(), user).toEqual(everything);
      expect(body.columns.map((c) => c.id).sort()).toEqual(everything);
      const records = await auditOf(res, 'submission.page_viewed');
      expect(records).toMatchObject([{ actorId: user, formId: form.id, metadata: { ids: [sub.id], count: 1 } }]);
    }
    // A redacted page is audited too, with the ids it showed.
    const redacted = await grid(form, who.checkerB);
    expect(await auditOf(redacted, 'submission.page_viewed')).toMatchObject([{ actorId: who.checkerB, metadata: { ids: [sub.id], count: 1 } }]);
  });
});

describe('the file of a response, with own_unit', () => {
  let form: Form;
  let sub: { id: string; fileId: string };
  beforeAll(async () => {
    form = await publishForm('File redaction', [unit('u_applicant', groupA), unit('u_notes', groupB, 'own_unit', 2)]);
    sub = await submitOne(form);
  });

  it('answers 404 to a unit-B checker for a unit-A file, leaves no file.downloaded record, and gives it to unit A and to a member in no group', async () => {
    for (const user of [who.checkerB, who.ownerB]) {
      const res = await download(form, sub.fileId, user);
      expect(res.statusCode, user).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
      expect(await auditOf(res, 'file.downloaded')).toEqual([]);
      expect(res.rawPayload.includes(PDF)).toBe(false);
    }
    for (const user of [who.checkerA, who.adminA, who.owner, who.admin]) {
      const res = await download(form, sub.fileId, user);
      expect(res.statusCode, user).toBe(200);
      expect(res.rawPayload.equals(PDF)).toBe(true);
      expect(await auditOf(res, 'file.downloaded')).toHaveLength(1);
    }
  });

  it('answers 404 to a redacted caller for a file no response holds yet: nothing says it is theirs', async () => {
    const orphan = await upload(form);
    expect((await download(form, orphan.fileId, who.checkerA)).statusCode).toBe(404);
    expect((await download(form, orphan.fileId, who.checkerB)).statusCode).toBe(404);
    expect((await download(form, orphan.fileId, who.owner)).statusCode).toBe(200);
  });
});

describe('a checker whose units are whole_submission', () => {
  it('sees everything, and so does a member of a group that has no unit on this form', async () => {
    const form = await publishForm('Whole', [unit('u_applicant', groupA), unit('u_notes', groupW, 'whole_submission', 2)]);
    const sub = await submitOne(form);
    const whole = await detail(form, sub.id, who.checkerW);
    expect(Object.keys(whole.json<Detail>().answers).sort()).toEqual(everything);
    expect((await download(form, sub.fileId, who.checkerW)).statusCode).toBe(200);
    expect((await grid(form, who.checkerW, 'q=ground')).statusCode).toBe(200);
    expect(Object.keys((await grid(form, who.checkerW)).json<GridBody>().items[0]!.cells).sort()).toEqual(everything);
    // Group A is own_unit on this form: still redacted there. Group B is assigned nothing on this form, so its members see all of it.
    expect(Object.keys((await detail(form, sub.id, who.checkerA)).json<Detail>().answers).sort()).toEqual(['cv', 'name', 'qty']);
    expect(Object.keys((await detail(form, sub.id, who.checkerB)).json<Detail>().answers).sort()).toEqual(everything);
  });

  it('is treated as redacted when it also sits in an own_unit group (own_unit wins): it reads the units of all its groups, and cannot search', async () => {
    const form = await publishForm('Both', [unit('u_applicant', groupA), unit('u_notes', groupB, 'whole_submission', 2)]);
    const sub = await submitOne(form);
    const user = randomUUID();
    await owner.query('insert into users (id, email, email_norm, email_verified_at) values ($1, $2, $2, now())', [user, 'both@review-redaction.test']);
    await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, user, 'editor']);
    for (const group of [groupA, groupB]) {
      expect((await app.inject({ method: 'PUT', url: `/v1/org/review-groups/${group}/members/${user}`, headers: as(who.owner) })).statusCode).toBe(200);
    }
    // The two units are the whole form, and both are theirs, so the blocks they may read are all of them; the search document is not theirs to match.
    expect(Object.keys((await detail(form, sub.id, user)).json<Detail>().answers).sort()).toEqual(everything);
    expect((await grid(form, user, 'q=ground')).statusCode).toBe(403);
  });

  it('stays redacted on a form whose review was switched off: the settings still assign the groups, and responses already held are still in review', async () => {
    // Switching review off stops new holds only; a checker keeps their scope for the responses already in review.
    const form = await publishForm('Switched off', [unit('u_applicant', groupA), unit('u_notes', groupB, 'own_unit', 2)]);
    const sub = await submitOne(form);
    const current = await app.inject({ url: `/v1/forms/${form.id}/review`, headers: as(who.owner) });
    const off = await app.inject({
      method: 'PUT',
      url: `/v1/forms/${form.id}/review`,
      headers: { ...as(who.owner), 'if-match': String(current.json<{ rev: number }>().rev) },
      payload: { enabled: false, distinctCheckers: false, units: current.json<{ units: unknown[] }>().units },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(Object.keys((await detail(form, sub.id, who.checkerB)).json<Detail>().answers).sort()).toEqual(['note', 'rate']);
  });
});

describe('after a unit is given to another group, with responses already in review', () => {
  it('keeps a unit-B checker redacted on the grid, the detail and the files: their group still decides unit B of the responses in flight', async () => {
    const form = await publishForm('Reassigned', [unit('u_applicant', groupA), unit('u_notes', groupB, 'own_unit', 2)]);
    const sub = await submitOne(form);
    // An ops.manage user gives unit B to group W. The response's review row keeps group B, which `review_decide()` reads.
    const current = await app.inject({ url: `/v1/forms/${form.id}/review`, headers: as(who.owner) });
    const moved = await app.inject({
      method: 'PUT',
      url: `/v1/forms/${form.id}/review`,
      headers: { ...as(who.owner), 'if-match': String(current.json<{ rev: number }>().rev) },
      payload: { enabled: true, distinctCheckers: false, units: [unit('u_applicant', groupA), unit('u_notes', groupW, 'own_unit', 2)] },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await owner.query('select group_id from submission_reviews where submission_id = $1 and unit_id = $2', [sub.id, 'u_notes'])).rows).toEqual([{ group_id: groupB }]);

    for (const user of [who.checkerB, who.ownerB]) {
      const one = await detail(form, sub.id, user);
      expect(one.statusCode, one.body).toBe(200);
      expect(Object.keys(one.json<Detail>().answers).sort(), user).toEqual(['note', 'rate']);
      const page = await grid(form, user);
      expect(page.statusCode, page.body).toBe(200);
      expect(Object.keys(page.json<GridBody>().items[0]!.cells).sort(), user).toEqual(['note', 'rate']);
      for (const res of [one, page]) for (const secret of A_TEXTS) expect(res.body, `${user}: ${secret}`).not.toContain(secret);
      expect((await download(form, sub.fileId, user)).statusCode, user).toBe(404);
    }
    // The new group's checker is redacted to unit B as well; unit A's checker is unchanged.
    expect(Object.keys((await detail(form, sub.id, who.checkerW)).json<Detail>().answers).sort()).toEqual(['note', 'rate']);
    expect(Object.keys((await detail(form, sub.id, who.checkerA)).json<Detail>().answers).sort()).toEqual(['cv', 'name', 'qty']);
  });
});

describe('the review status of a response in the list and the detail', () => {
  let form: Form;
  let held: { id: string; fileId: string };
  let rejected: { id: string; fileId: string };
  let complete: string;

  beforeAll(async () => {
    form = await publishForm('Statuses', [unit('u_applicant', groupA), unit('u_notes', groupB, 'own_unit', 2)]);
    held = await submitOne(form);
    rejected = await submitOne(form);
    // A required reject finalises the response: it is `rejected` and its other units are `closed` (what review_decide() leaves).
    // The decision route is a later task's; the state it leaves is set here, as the table's owner.
    await owner.query("update submission_reviews set state = case unit_id when 'u_applicant' then 'rejected' else 'closed' end where submission_id = $1", [rejected.id]);
    await owner.query("update submissions set status = 'rejected' where id = $1", [rejected.id]);
    complete = await storePlain(form, 'complete');
  });

  it('lists only the held responses for status=pending_review, each with its units by name and state', async () => {
    const res = await grid(form, who.owner, 'status=pending_review');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<GridBody>();
    expect(body.items.map((i) => i.id)).toEqual([held.id]);
    expect(body.items[0]).toMatchObject({
      status: 'pending_review',
      review: [
        { name: 'Applicant', state: 'pending' },
        { name: 'Notes', state: 'pending' },
      ],
    });
    // Nothing but name and state: no group, checker, round, hash or order.
    for (const unit of body.items[0]!.review ?? []) expect(Object.keys(unit).sort()).toEqual(['name', 'state']);
  });

  it('lists only the rejected response for status=rejected, with the state of each unit', async () => {
    const body = (await grid(form, who.owner, 'status=rejected')).json<GridBody>();
    expect(body.items.map((i) => i.id)).toEqual([rejected.id]);
    expect(body.items[0]!.review).toEqual([
      { name: 'Applicant', state: 'rejected' },
      { name: 'Notes', state: 'closed' },
    ]);
  });

  it('has no review key on a response that was never held, and lists every response in the unfiltered inbox', async () => {
    const res = await grid(form, who.owner);
    const body = res.json<GridBody>();
    expect(new Set(body.items.map((i) => i.id))).toEqual(new Set([held.id, rejected.id, complete]));
    // The row of a response that was not reviewed is what it was before review existed: no key at all.
    expect(Object.keys(body.items.find((i) => i.id === complete)!)).not.toContain('review');
    expect(body.items.find((i) => i.id === held.id)?.review).toHaveLength(2);
    expect((await grid(form, who.owner, 'status=complete')).json<GridBody>().items.map((i) => i.id)).toEqual([complete]);
  });

  it('works for a redacted checker too: the filter and the summary are not redacted, the cells are', async () => {
    const res = await grid(form, who.checkerB, 'status=pending_review');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<GridBody>();
    expect(body.items.map((i) => i.id)).toEqual([held.id]);
    expect(Object.keys(body.items[0]!.cells).sort()).toEqual(['note', 'rate']);
    expect(body.items[0]!.review?.map((u) => u.name)).toEqual(['Applicant', 'Notes']);
  });

  it('puts the same review in the detail, and none for a response never held', async () => {
    expect((await detail(form, rejected.id, who.owner)).json<Detail>()).toMatchObject({
      status: 'rejected',
      review: [
        { name: 'Applicant', state: 'rejected' },
        { name: 'Notes', state: 'closed' },
      ],
    });
    expect(Object.keys((await detail(form, complete, who.owner)).json<Detail>())).not.toContain('review');
  });

  it('names a unit by the version the response was filed under, not by the form as it is now', async () => {
    const f = await publishForm('Renamed', [unit('u_applicant', groupA), unit('u_notes', groupB, 'own_unit', 2)]);
    const sub = await submitOne(f);
    const next = draftOf(f.id, 'Renamed') as unknown as { review: { units: Array<{ name: string }> } };
    next.review.units[0]!.name = 'Applicant, renamed';
    const put = await app.inject({ method: 'PUT', url: `/v1/forms/${f.id}/draft`, headers: { ...as(who.owner), 'if-match': '1' }, payload: { draft: next } });
    expect(put.statusCode, put.body).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/v1/forms/${f.id}/publish`, headers: as(who.owner), payload: {} })).statusCode).toBe(200);
    expect((await detail(f, sub.id, who.owner)).json<Detail>().review?.map((u) => u.name)).toEqual(['Applicant', 'Notes']);
  });
});
