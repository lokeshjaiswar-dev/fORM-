import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPgBossQueue, installQueueSchema, parseJobKeyring, type PgBossQueue } from '@form/adapters/queue';
import { createPostgresSearchIndex } from '@form/adapters/search';
import { provision } from '@form/db';
import type { FormDefinition } from '@form/schema';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { createFileStore } from '../src/files.ts';
import { SESSION_COOKIE } from '../src/modules/auth/index.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

/*
 * WP-2.33, the checker's side of a held response: the review queue (`GET /v1/reviews/queue`), the review detail with its
 * own_unit redaction (`GET .../submissions/:id/review`) and the decision of a unit (`POST .../review/units/:unitId/decisions`)
 * with its finalisation. Responses are made the way they really arrive (a respondent's POST to a form whose review is on), and
 * the checkers are real members in review groups. The cross-org cases of every route are also in the isolation suite
 * (isolation-cases/reviews.ts); this file proves the behaviour inside one org, and that a second org sees nothing of it.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
/** More than any test sends from one address, so the throttle never speaks. */
const BUDGET = { max: 100_000, windowSeconds: 600 };
const RESPONDENT = 'asha.rao@respondent.test';
const BACKUP = 'asha.backup@respondent.test';
const OTHER_RESPONDENT = 'someone.else@respondent.test';
const UNIT_A_TEXT = 'Asha Rao Applicant 4d1f';
const NOTE_TEXT = 'Needs a ground floor room 4d1f';
const FREE_TEXT = 'Heard about us from a friend 4d1f';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');

let app: FastifyInstance;
let owner: pg.Pool;
let queue: PgBossQueue;
let dir: string;
let orgId: string;
let otherOrgId: string;
let groupA: string;
let groupB: string;
/** Added to the app's clock, so a test can let a response age without waiting (always put back to 0). */
let skewMs = 0;

const id = {
  /** An owner in no review group. */
  owner: randomUUID(),
  admin: randomUUID(),
  viewer: randomUUID(),
  creator: randomUUID(),
  /** Editors: checkers of group A. */
  a1: randomUUID(),
  a2: randomUUID(),
  /** Their verified address is the one the respondent types, so they are excluded from checking that response. */
  matching: randomUUID(),
  /** An editor in both groups. */
  both: randomUUID(),
  /** An editor of group A who never enrolled two-factor sign-in. */
  noTotp: randomUUID(),
  /** Checkers of group B: an editor, and an owner (owners are redacted when they check a unit). */
  b1: randomUUID(),
  ownerB: randomUUID(),
  /** An editor in no group. */
  bystander: randomUUID(),
  otherOwner: randomUUID(),
  otherEditor: randomUUID(),
};

interface Published {
  id: string;
  slug: string;
  versionId: string;
  /** The form has a third review unit (and its block). */
  extra?: boolean;
  /** The applicant unit also holds a file upload, which `submit` fills in. */
  file?: boolean;
}

const short = (value: string) => ({ type: 'short_text', value });
const mail = (address: string) => ({ type: 'email', value: { address } });
const sha = (text: string) => createHash('sha256').update(text).digest();

/**
 * Pages: 1 (the applicant: name, email, backup), 2 (the notes), 3 (an extra, when the form has a third unit) and 4 (a
 * block no unit covers, which every checker sees). One review unit per page but the last.
 */
function reviewedDraft(formId: string, title: string, o: { extra: boolean; file: boolean }): FormDefinition {
  const blocks = [
    fieldBlock('name', 'short_text'),
    fieldBlock('email', 'email'),
    fieldBlock('backup', 'email'),
    fieldBlock('cv', 'file_upload', { accept: { extensions: ['pdf'], mimeTypes: ['application/pdf'] } }),
    fieldBlock('note', 'short_text'),
    fieldBlock('extra', 'short_text'),
    fieldBlock('free', 'short_text'),
  ];
  const base = draftWith(formId, blocks, title);
  const pages = [
    { ...base.pages[0]!, children: ['name', 'email', 'backup', ...(o.file ? ['cv'] : [])] },
    { id: 'page_2', children: ['note'] },
    ...(o.extra ? [{ id: 'page_3', children: ['extra'] }] : []),
    { id: 'page_4', children: ['free'] },
  ];
  const units = [
    { id: 'u_applicant', name: 'Applicant', target: { kind: 'page', pageId: 'page_1' } },
    { id: 'u_notes', name: 'Notes', target: { kind: 'page', pageId: 'page_2' } },
    ...(o.extra ? [{ id: 'u_extra', name: 'Extra', target: { kind: 'page', pageId: 'page_3' } }] : []),
  ];
  const kept = new Set(pages.flatMap((p) => p.children as string[]));
  return { ...base, blocks: Object.fromEntries(Object.entries(base.blocks).filter(([key]) => kept.has(key))), pages, review: { units } } as unknown as FormDefinition;
}

const as = (userId: string, org: string = orgId) => ({ 'x-fr-dev-user': userId, 'x-fr-org': org, ...BROWSER });

interface Call {
  as?: string;
  org?: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, o: Call = {}): Promise<LightMyRequestResponse> {
  const who = o.cookie ? { cookie: o.cookie, 'x-fr-org': o.org ?? orgId, ...BROWSER } : as(o.as ?? id.owner, o.org ?? orgId);
  return app.inject({ method, url, headers: { ...who, ...o.headers }, ...(o.body === undefined ? {} : { payload: o.body as Record<string, unknown> }) });
}

async function ok<T>(res: LightMyRequestResponse, status = 200): Promise<T> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json<T>();
}

async function publishDraft(title: string, make: (formId: string) => FormDefinition): Promise<Published> {
  const { id: formId } = await ok<{ id: string }>(await call('POST', '/v1/forms', { body: { title } }));
  await ok(await call('PUT', `/v1/forms/${formId}/draft`, { body: { draft: make(formId) }, headers: { 'if-match': '0' } }));
  return { id: formId, ...(await ok<{ slug: string; versionId: string }>(await call('POST', `/v1/forms/${formId}/publish`, { body: {} }))) };
}

interface Assignment {
  unitId: string;
  groupId: string;
  order: number;
  required: boolean;
  visibility: 'own_unit' | 'whole_submission';
}
const assign = (unitId: string, o: Partial<Assignment> = {}): Assignment => ({ unitId, groupId: groupA, order: 1, required: true, visibility: 'own_unit', ...o });

async function saveSettings(formId: string, units: Assignment[], o: { distinct?: boolean; enabled?: boolean } = {}): Promise<void> {
  const current = await ok<{ rev: number }>(await call('GET', `/v1/forms/${formId}/review`));
  await ok(await call('PUT', `/v1/forms/${formId}/review`, { body: { enabled: o.enabled ?? true, distinctCheckers: o.distinct ?? false, units }, headers: { 'if-match': String(current.rev) } }));
}

/** A published form whose review is assigned as given: by default the applicant unit to group A and the notes (after it) to group B. */
async function reviewedForm(title: string, o: { extra?: boolean; file?: boolean; distinct?: boolean; units?: Assignment[] } = {}): Promise<Published> {
  const form = await publishDraft(title, (formId) => reviewedDraft(formId, title, { extra: o.extra === true, file: o.file === true }));
  const units = o.units ?? [assign('u_applicant'), assign('u_notes', { groupId: groupB, order: 2 }), ...(o.extra ? [assign('u_extra', { groupId: groupB, order: 2, required: false })] : [])];
  await saveSettings(form.id, units, { distinct: o.distinct === true });
  return { ...form, extra: o.extra === true, file: o.file === true };
}

const answersOf = (o: { email?: string; extra?: boolean | undefined } = {}) => ({
  name: short(UNIT_A_TEXT),
  email: mail(o.email ?? RESPONDENT),
  backup: mail(BACKUP),
  note: short(NOTE_TEXT),
  ...(o.extra ? { extra: short('Extra answer 4d1f') } : {}),
  free: short(FREE_TEXT),
});

/** A respondent's POST; returns the id of the held response. */
async function submit(f: Published, o: { email?: string } = {}): Promise<string> {
  const answers: Record<string, unknown> = answersOf({ ...o, extra: f.extra });
  if (f.file) {
    const up = await app.inject({ method: 'POST', url: `/v1/p/${f.slug}/files`, payload: { blockId: 'cv', name: 'cv.pdf', mime: 'application/pdf', data: PDF.toString('base64') } });
    answers['cv'] = { type: 'file_upload', value: [(await ok<Record<string, unknown>>(up))] };
  }
  const res = await app.inject({
    method: 'POST',
    url: `/v1/p/${f.slug}/submissions`,
    headers: { 'idempotency-key': randomUUID() },
    payload: { formVersionId: f.versionId, answers, fields: [], locale: 'en-IN' },
  });
  const body = await ok<{ submissionId: string; held?: string }>(res);
  expect(body.held).toBe('pending_review');
  return body.submissionId;
}

interface Decision {
  as?: string;
  cookie?: string;
  key?: string;
  body?: Record<string, unknown>;
  org?: string;
  formId?: string;
}

const hashOf = async (submissionId: string, unitId: string): Promise<string> =>
  (await owner.query<{ h: string }>(`select encode(answers_hash, 'hex') as h from submission_reviews where submission_id = $1 and unit_id = $2`, [submissionId, unitId])).rows[0]!.h;

/** The POST of a decision. The hash is the unit's current one unless the test says otherwise (`body.answersHash`). */
async function decide(f: Published, submissionId: string, unitId: string, o: Decision = {}): Promise<LightMyRequestResponse> {
  const body = { decision: 'approve', answersHash: o.body?.['answersHash'] ?? (await hashOf(submissionId, unitId)), ...o.body };
  return call('POST', `/v1/forms/${o.formId ?? f.id}/submissions/${submissionId}/review/units/${unitId}/decisions`, {
    ...(o.cookie ? { cookie: o.cookie } : { as: o.as ?? id.a1 }),
    org: o.org ?? orgId,
    body,
    headers: { 'idempotency-key': o.key ?? randomUUID() },
  });
}

const detail = (f: Published, submissionId: string, o: { as?: string; cookie?: string; org?: string } = {}) =>
  call('GET', `/v1/forms/${f.id}/submissions/${submissionId}/review`, { ...(o.cookie ? { cookie: o.cookie } : { as: o.as ?? id.owner }), ...(o.org ? { org: o.org } : {}) });

interface QueueItem {
  submissionId: string;
  formId: string;
  formTitle: string;
  unitId: string;
  unitName: string;
  round: number;
  order: number;
  required: boolean;
  receivedAt: string;
  ageSeconds: number;
}
const queueOf = async (as_: string, query = '', org: string = orgId): Promise<{ items: QueueItem[]; nextCursor: string | null }> =>
  ok(await call('GET', `/v1/reviews/queue${query}`, { as: as_, org }));

interface ReviewRow {
  unit_id: string;
  state: string;
  rev: number;
  maker_user_id: string | null;
}
const reviewRows = async (submissionId: string): Promise<ReviewRow[]> =>
  (await owner.query<ReviewRow>(`select unit_id, state, rev, maker_user_id from submission_reviews where submission_id = $1 order by unit_id`, [submissionId])).rows;
const statusOf = async (submissionId: string): Promise<string> => (await owner.query<{ status: string }>('select status from submissions where id = $1', [submissionId])).rows[0]!.status;
const decisionRows = async (submissionId: string) =>
  (await owner.query<{ id: string; unit_id: string; decision: string; reason_code: string | null; decided_by: string }>(`select id, unit_id, decision, reason_code, decided_by from review_decisions where submission_id = $1 order by decided_at, id`, [submissionId])).rows;
const fanoutJobs = async (formId: string): Promise<Array<{ data: { data: Record<string, unknown> } }>> =>
  (await owner.query(`select data from pgboss.job where name = 'submission.fanout' and data -> 'resource' ->> 'id' = $1 order by created_on`, [formId])).rows;

/** The events an action left in the org's pending audit log for one resource, oldest first (the chain worker does not run here). */
async function events(action: string, resourceId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'action' = $2 and event->>'resourceId' = $3 order by id`, [orgId, action, resourceId]);
  return rows.map((r) => r.event);
}
/** Every event one request left, by its request id: a refused decision must leave one record, not two. */
async function eventsOfRequest(res: LightMyRequestResponse): Promise<Array<Record<string, unknown>>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'requestId' = $2 order by id`, [orgId, res.headers['x-request-id']]);
  return rows.map((r) => r.event);
}

const setMfa = (on: boolean) =>
  owner.query(`insert into org_settings (org_id, review_checkers_mfa) values ($1, $2) on conflict (org_id) do update set review_checkers_mfa = excluded.review_checkers_mfa`, [orgId, on]);

/** A session cookie for a user, with the factors it was signed in with (`pwd`, `pwd+totp`). */
async function sessionOf(userId: string, mfaLevel: 'pwd' | 'pwd+totp'): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await owner.query(
    `insert into sessions (id, token_hash, user_id, mfa_level, idle_expires_at, absolute_expires_at) values ($1, $2, $3, $4, now() + interval '1 hour', now() + interval '1 day')`,
    [randomUUID(), sha(token), userId, mfaLevel],
  );
  return `${SESSION_COOKIE}=${token}`;
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_review_decide');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  await installQueueSchema({ connectionString: urls.fr_migrator, appRole: 'fr_app' });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  dir = await mkdtemp(path.join(tmpdir(), 'fr-review-decide-'));
  orgId = randomUUID();
  otherOrgId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2), ($3, $4, $4)', [orgId, 'review-decide', otherOrgId, 'review-decide-other']);
  const people: Array<{ id: string; role: string; org: string; email?: string; name: string; totp?: boolean }> = [
    { id: id.owner, role: 'owner', org: orgId, name: 'Olive Owner' },
    { id: id.admin, role: 'admin', org: orgId, name: 'Adam Admin' },
    { id: id.viewer, role: 'viewer', org: orgId, name: 'Vik Viewer' },
    { id: id.creator, role: 'creator', org: orgId, name: 'Cora Creator' },
    { id: id.a1, role: 'editor', org: orgId, name: 'Anil Checker', totp: true },
    { id: id.a2, role: 'editor', org: orgId, name: 'Amrita Checker', totp: true },
    { id: id.matching, role: 'editor', org: orgId, email: RESPONDENT, name: 'Asha Match', totp: true },
    { id: id.both, role: 'editor', org: orgId, name: 'Bo Both', totp: true },
    { id: id.noTotp, role: 'editor', org: orgId, name: 'Nikhil NoTotp' },
    { id: id.b1, role: 'editor', org: orgId, name: 'Bala Checker', totp: true },
    { id: id.ownerB, role: 'owner', org: orgId, name: 'Berta Owner', totp: true },
    { id: id.bystander, role: 'editor', org: orgId, name: 'Bea Bystander', totp: true },
    { id: id.otherOwner, role: 'owner', org: otherOrgId, name: 'Otto Other', totp: true },
    { id: id.otherEditor, role: 'editor', org: otherOrgId, name: 'Ella Other', totp: true },
  ];
  for (const p of people) {
    await owner.query(`insert into users (id, email, email_norm, name, email_verified_at, totp_enabled_at) values ($1, $2, $2, $3, now(), ${p.totp ? 'now()' : 'null'})`, [p.id, p.email ?? `u-${p.id.slice(0, 8)}@review-decide.test`, p.name]);
    await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [p.org, p.id, p.role]);
  }
  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  const keyring = parseJobKeyring(`t1:${Buffer.alloc(32, 7).toString('base64url')}`);
  // The composition root's wiring (`main.ts`): a producer queue on the app's own database, and the Postgres search index.
  queue = createPgBossQueue({ connectionString: urls.fr_app, keyring, mode: 'producer', max: 2, applicationName: 'fr-api-review-decide-test' });
  await queue.start();
  app = await buildApp(parsed.config, {
    underPressure: false,
    files: createFileStore(dir),
    searchIndex: createPostgresSearchIndex,
    queue,
    now: () => new Date(Date.now() + skewMs),
    authLimits: { auth_submit_ip: BUDGET, auth_submit_form: BUDGET, auth_files_ip: BUDGET, auth_files_form: BUDGET },
  });
  const group = async (name: string, org: string, as_: string, members: string[]): Promise<string> => {
    const created = await ok<{ id: string }>(await call('POST', '/v1/org/review-groups', { as: as_, org, body: { name } }), 201);
    for (const userId of members) await ok(await call('PUT', `/v1/org/review-groups/${created.id}/members/${userId}`, { as: as_, org }));
    return created.id;
  };
  groupA = await group('Group A', orgId, id.owner, [id.a1, id.a2, id.matching, id.both, id.noTotp]);
  groupB = await group('Group B', orgId, id.owner, [id.b1, id.ownerB, id.both]);
  await group('Other org checkers', otherOrgId, id.otherOwner, [id.otherOwner, id.otherEditor]);
});

afterAll(async () => {
  await app?.close();
  await queue?.stop({ graceMs: 1000 });
  await owner?.end();
  await rm(dir, { recursive: true, force: true });
});

describe('deciding a unit', () => {
  it('approves one unit: the decision, the unit and one review.decided record with no answer in it; the response stays held and nothing is sent', async () => {
    const f = await reviewedForm('Decide one');
    const sub = await submit(f);
    const res = await decide(f, sub, 'u_applicant', { as: id.a1 });
    const body = await ok<Record<string, unknown>>(res);
    expect(body).toMatchObject({ unitId: 'u_applicant', decision: 'approve', reasonCode: null, round: 1, unitState: 'approved', submissionStatus: 'pending_review' });
    expect(body['decisionId']).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(String(body['decidedAt']))).not.toBeNaN();

    expect((await reviewRows(sub)).map((r) => [r.unit_id, r.state, r.rev])).toEqual([
      ['u_applicant', 'approved', 2],
      ['u_notes', 'pending', 1],
    ]);
    expect(await decisionRows(sub)).toEqual([expect.objectContaining({ id: body['decisionId'], unit_id: 'u_applicant', decision: 'approve', reason_code: null, decided_by: id.a1 })]);
    expect(await statusOf(sub)).toBe('pending_review');
    expect(await fanoutJobs(f.id)).toEqual([]);

    const decided = await events('review.decided', sub);
    expect(decided).toEqual([
      expect.objectContaining({
        actorKind: 'user',
        actorId: id.a1,
        outcome: 'success',
        resourceType: 'submission',
        formId: f.id,
        metadata: { unitId: 'u_applicant', decision: 'approve', reasonCode: null, round: 1, decisionId: body['decisionId'], unitState: 'approved', submissionStatus: 'pending_review' },
      }),
    ]);
    expect(JSON.stringify(decided)).not.toContain('Asha');
    expect(JSON.stringify(decided)).not.toContain(RESPONDENT);
    expect(await events('review.finalised', sub)).toEqual([]);
  });

  it('refuses the respondent’s own address and the maker, the last editor and a second decision under distinct checkers: 403 FOUR_EYES_VIOLATION, one denied record, nothing written', async () => {
    const f = await reviewedForm('Four eyes');
    const sub = await submit(f);

    // A member whose verified address is the one the respondent typed (excluded when the review opened).
    const matching = await decide(f, sub, 'u_applicant', { as: id.matching });
    expect(matching.statusCode, matching.body).toBe(403);
    expect(matching.json()).toMatchObject({ code: 'FOUR_EYES_VIOLATION' });
    // One record for the refusal: the review's own, not a second generic `request.authorize`.
    expect(await eventsOfRequest(matching)).toEqual([expect.objectContaining({ action: 'review.decided', outcome: 'denied', actorId: id.matching, reason: 'four_eyes_violation', resourceId: sub, formId: f.id, metadata: { unitId: 'u_applicant', decision: 'approve' } })]);

    // The maker and the last editor of the unit (no sign-in fill path exists yet, so the rows are set as that path will).
    await owner.query(`update submission_reviews set maker_user_id = $2 where submission_id = $1 and unit_id = 'u_applicant'`, [sub, id.a2]);
    const maker = await decide(f, sub, 'u_applicant', { as: id.a2 });
    expect(maker.json()).toMatchObject({ code: 'FOUR_EYES_VIOLATION' });
    expect(maker.statusCode).toBe(403);
    await owner.query(`update submission_reviews set maker_user_id = null, last_editor_id = $2 where submission_id = $1 and unit_id = 'u_applicant'`, [sub, id.a2]);
    const editor = await decide(f, sub, 'u_applicant', { as: id.a2 });
    expect(editor.json()).toMatchObject({ code: 'FOUR_EYES_VIOLATION' });
    expect(editor.statusCode).toBe(403);

    expect(await decisionRows(sub)).toEqual([]);
    expect((await reviewRows(sub)).map((r) => r.state)).toEqual(['pending', 'pending']);
    expect(await events('review.decided', sub)).toHaveLength(3);
    expect((await events('review.decided', sub)).every((e) => e['outcome'] === 'denied')).toBe(true);

    // Somebody else of the group decides it.
    await ok(await decide(f, sub, 'u_applicant', { as: id.a1 }));
  });

  it('with distinct checkers, refuses a member who decided another unit of the same response', async () => {
    const f = await reviewedForm('Distinct', { distinct: true, units: [assign('u_applicant'), assign('u_notes', { groupId: groupB, order: 2 })] });
    const sub = await submit(f);
    await ok(await decide(f, sub, 'u_applicant', { as: id.both }));
    const second = await decide(f, sub, 'u_notes', { as: id.both });
    expect(second.statusCode, second.body).toBe(403);
    expect(second.json()).toMatchObject({ code: 'FOUR_EYES_VIOLATION' });
    // Another checker of group B may.
    expect((await decide(f, sub, 'u_notes', { as: id.b1 })).statusCode).toBe(200);
  });

  it('two checkers approving one unit at once: one 200 and one 409 REVIEW_CLOSED, one decision, one success record and one denied', async () => {
    const f = await reviewedForm('Parallel');
    const sub = await submit(f);
    const [x, y] = await Promise.all([decide(f, sub, 'u_applicant', { as: id.a1 }), decide(f, sub, 'u_applicant', { as: id.a2 })]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    const lost = x.statusCode === 409 ? x : y;
    expect(lost.json()).toMatchObject({ code: 'REVIEW_CLOSED' });
    expect(await decisionRows(sub)).toHaveLength(1);
    const records = await events('review.decided', sub);
    expect(records.map((e) => e['outcome']).sort()).toEqual(['denied', 'success']);
    expect(records.find((e) => e['outcome'] === 'denied')).toMatchObject({ reason: 'review_closed' });
  });

  it('a replayed Idempotency-Key returns the first decision’s body, writes and sends nothing again; the key for another decision is 422', async () => {
    const f = await reviewedForm('Replay');
    const sub = await submit(f);
    const key = `replay-${randomUUID()}`;
    const first = await decide(f, sub, 'u_applicant', { as: id.a1, key });
    const firstBody = await ok<Record<string, unknown>>(first);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const again = await decide(f, sub, 'u_applicant', { as: id.a1, key });
    expect(await ok(again)).toEqual(firstBody);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(await decisionRows(sub)).toHaveLength(1);
    expect(await events('review.decided', sub)).toHaveLength(1);

    // The same key for another decision, another unit or another checker is not a retry.
    const other = await decide(f, sub, 'u_applicant', { as: id.a1, key, body: { decision: 'reject', reasonCode: 'other' } });
    expect(other.statusCode, other.body).toBe(422);
    expect(other.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await eventsOfRequest(other)).toEqual([expect.objectContaining({ action: 'review.decided', outcome: 'denied', reason: 'idempotency_key_reused' })]);
    const elsewhere = await decide(f, sub, 'u_notes', { as: id.b1, key });
    expect(elsewhere.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const stranger = await decide(f, sub, 'u_applicant', { as: id.a2, key });
    expect(stranger.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await decisionRows(sub)).toHaveLength(1);
  });

  it('the same request twice at once is one decision: both answer 200 with the same body', async () => {
    const f = await reviewedForm('Replay at once');
    const sub = await submit(f);
    const key = `at-once-${randomUUID()}`;
    const [x, y] = await Promise.all([decide(f, sub, 'u_applicant', { as: id.a1, key }), decide(f, sub, 'u_applicant', { as: id.a1, key })]);
    expect(x.statusCode, x.body).toBe(200);
    expect(y.statusCode, y.body).toBe(200);
    expect(x.json()).toEqual(y.json());
    expect([x.headers['idempotent-replayed'], y.headers['idempotent-replayed']].sort()).toEqual(['true', undefined]);
    expect(await decisionRows(sub)).toHaveLength(1);
    expect(await events('review.decided', sub)).toHaveLength(1);
  });

  it('needs the Idempotency-Key header: 400 without it, and a key that is not visible text', async () => {
    const f = await reviewedForm('Key');
    const sub = await submit(f);
    const url = `/v1/forms/${f.id}/submissions/${sub}/review/units/u_applicant/decisions`;
    const body = { decision: 'approve', answersHash: await hashOf(sub, 'u_applicant') };
    const none = await call('POST', url, { as: id.a1, body });
    expect(none.statusCode, none.body).toBe(400);
    expect(none.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    for (const key of ['has space', 'x'.repeat(256)]) expect((await call('POST', url, { as: id.a1, body, headers: { 'idempotency-key': key } })).statusCode, key).toBe(400);
    expect(await decisionRows(sub)).toEqual([]);
  });

  it('refuses a decision about answers that changed since they were read: 409 REVIEW_STALE', async () => {
    const f = await reviewedForm('Stale');
    const sub = await submit(f);
    const read = await ok<{ units: Array<{ unitId: string; answersHash: string }> }>(await detail(f, sub, { as: id.a1 }));
    const hash = read.units.find((u) => u.unitId === 'u_applicant')!.answersHash;
    // The hash of another unit's answers, and the hash of nothing.
    for (const wrong of [await hashOf(sub, 'u_notes'), sha('nothing').toString('hex')]) {
      const res = await decide(f, sub, 'u_applicant', { as: id.a1, body: { answersHash: wrong } });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ code: 'REVIEW_STALE' });
    }
    expect(await events('review.decided', sub)).toHaveLength(2);
    // The one the detail gave is the current one.
    expect((await decide(f, sub, 'u_applicant', { as: id.a1, body: { answersHash: hash.toUpperCase() } })).statusCode).toBe(200);
  });

  it('a unit waits for the required units of a lower order: 409 REVIEW_ORDER_BLOCKED, then it can be decided', async () => {
    const f = await reviewedForm('Order');
    const sub = await submit(f);
    const blocked = await decide(f, sub, 'u_notes', { as: id.b1 });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'REVIEW_ORDER_BLOCKED' });
    expect(await events('review.decided', sub)).toEqual([expect.objectContaining({ outcome: 'denied', reason: 'order_blocked' })]);
    await ok(await decide(f, sub, 'u_applicant', { as: id.a1 }));
    await ok(await decide(f, sub, 'u_notes', { as: id.b1 }));
  });

  it('a member of another unit’s group is not a checker of this one: 403 NOT_IN_REVIEW_GROUP, whatever their role', async () => {
    const f = await reviewedForm('Group');
    const sub = await submit(f);
    for (const who of [id.b1, id.ownerB, id.bystander, id.owner, id.admin]) {
      const res = await decide(f, sub, 'u_applicant', { as: who });
      expect(res.statusCode, `${who}: ${res.body}`).toBe(403);
      expect(res.json()).toMatchObject({ code: 'NOT_IN_REVIEW_GROUP' });
    }
    expect(await decisionRows(sub)).toEqual([]);
    expect((await events('review.decided', sub)).map((e) => e['reason'])).toEqual(Array(5).fill('not_in_group'));
  });

  describe('two-factor sign-in of checkers', () => {
    it('with the org setting on, a session without the second factor gets 403 MFA_REQUIRED and a denied record, though the user enrolled; one with it decides', async () => {
      const f = await reviewedForm('Mfa');
      const sub = await submit(f);
      const pwd = await sessionOf(id.a1, 'pwd');
      const refused = await decide(f, sub, 'u_applicant', { cookie: pwd });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'MFA_REQUIRED' });
      expect(await eventsOfRequest(refused)).toEqual([expect.objectContaining({ action: 'review.decided', outcome: 'denied', reason: 'mfa_required', actorId: id.a1 })]);
      expect(await decisionRows(sub)).toEqual([]);

      const both = await sessionOf(id.a1, 'pwd+totp');
      await ok(await decide(f, sub, 'u_applicant', { cookie: both }));
    });

    it('a user who never enrolled is refused by review_decide() itself, whatever the session says', async () => {
      const f = await reviewedForm('Mfa enrolment');
      const sub = await submit(f);
      for (const res of [await decide(f, sub, 'u_applicant', { as: id.noTotp }), await decide(f, sub, 'u_applicant', { cookie: await sessionOf(id.noTotp, 'pwd+totp') })]) {
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
      }
      expect((await events('review.decided', sub)).map((e) => e['reason'])).toEqual(['mfa_required', 'mfa_required']);
    });

    it('with the org setting off, neither is needed', async () => {
      await setMfa(false);
      try {
        const f = await reviewedForm('Mfa off');
        const sub = await submit(f);
        await ok(await decide(f, sub, 'u_applicant', { cookie: await sessionOf(id.a1, 'pwd') }));
        const second = await submit(f);
        await ok(await decide(f, second, 'u_applicant', { as: id.noTotp }));
      } finally {
        await setMfa(true);
      }
    });
  });

  it('approving every required unit completes the response and sends exactly one submission.fanout "released"; an optional unit still open is closed', async () => {
    const f = await reviewedForm('Finalise', { extra: true });
    const sub = await submit(f);
    await ok(await decide(f, sub, 'u_applicant', { as: id.a1 }));
    expect(await fanoutJobs(f.id)).toEqual([]);
    const key = `last-${randomUUID()}`;
    const last = await decide(f, sub, 'u_notes', { as: id.b1, key });
    const body = await ok<Record<string, unknown>>(last);
    expect(body).toMatchObject({ unitId: 'u_notes', unitState: 'approved', submissionStatus: 'complete' });

    expect(await statusOf(sub)).toBe('complete');
    expect((await reviewRows(sub)).map((r) => [r.unit_id, r.state])).toEqual([
      ['u_applicant', 'approved'],
      ['u_extra', 'closed'],
      ['u_notes', 'approved'],
    ]);
    const jobs = await fanoutJobs(f.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data.data).toMatchObject({ submissionId: sub, event: 'released' });
    expect(await events('review.finalised', sub)).toEqual([expect.objectContaining({ actorId: id.b1, outcome: 'success', metadata: { status: 'complete', unitId: 'u_notes', decisionId: body['decisionId'] } })]);

    // A retry of the settling decision sends no second job and writes no second record.
    const replay = await decide(f, sub, 'u_notes', { as: id.b1, key });
    expect(await ok(replay)).toEqual(body);
    expect(await fanoutJobs(f.id)).toHaveLength(1);
    expect(await events('review.finalised', sub)).toHaveLength(1);
    expect(await events('review.decided', sub)).toHaveLength(2);
    // And nothing more can be decided.
    const late = await decide(f, sub, 'u_extra', { as: id.b1 });
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json()).toMatchObject({ code: 'REVIEW_CLOSED' });
    expect(await fanoutJobs(f.id)).toHaveLength(1);
  });

  it('rejecting a required unit makes the response rejected at once, closes the rest and sends nothing', async () => {
    const f = await reviewedForm('Reject');
    const sub = await submit(f);
    const res = await decide(f, sub, 'u_applicant', { as: id.a1, body: { decision: 'reject', reasonCode: 'missing_document' } });
    const body = await ok<Record<string, unknown>>(res);
    expect(body).toMatchObject({ decision: 'reject', reasonCode: 'missing_document', unitState: 'rejected', submissionStatus: 'rejected' });
    expect(await statusOf(sub)).toBe('rejected');
    expect((await reviewRows(sub)).map((r) => [r.unit_id, r.state])).toEqual([
      ['u_applicant', 'rejected'],
      ['u_notes', 'closed'],
    ]);
    expect(await decisionRows(sub)).toEqual([expect.objectContaining({ decision: 'reject', reason_code: 'missing_document' })]);
    expect(await fanoutJobs(f.id)).toEqual([]);
    expect(await events('review.finalised', sub)).toEqual([expect.objectContaining({ metadata: { status: 'rejected', unitId: 'u_applicant', decisionId: body['decisionId'] } })]);
    expect((await decide(f, sub, 'u_notes', { as: id.b1 })).json()).toMatchObject({ code: 'REVIEW_CLOSED' });
    expect(await fanoutJobs(f.id)).toEqual([]);
  });

  it('refuses a body that is not a decision: a reject without a reason, an approve with one, a reason outside the catalogue, a return, any other key (400)', async () => {
    const f = await reviewedForm('Body');
    const sub = await submit(f);
    const bad: Array<Record<string, unknown>> = [
      { decision: 'reject' },
      { decision: 'approve', reasonCode: 'other' },
      { decision: 'reject', reasonCode: 'because' },
      { decision: 'return', reasonCode: 'other' },
      { decision: 'approve', note: 'looks fine' },
      { decision: 'approve', decidedBy: id.owner },
      { decision: 'approve', answersHash: 'abc' },
    ];
    for (const body of bad) {
      const res = await decide(f, sub, 'u_applicant', { as: id.a1, body });
      expect(res.statusCode, `${JSON.stringify(body)}: ${res.body}`).toBe(400);
    }
    expect(await decisionRows(sub)).toEqual([]);
    expect(await events('review.decided', sub)).toEqual([]);
  });

  it('answers 404 for a unit the response does not have, a response of another form, an id that is not a response, and another org’s response', async () => {
    const f = await reviewedForm('Not found');
    const g = await reviewedForm('Not found, the other form');
    const sub = await submit(f);
    const hash = await hashOf(sub, 'u_applicant');
    const missingUnit = await decide(f, sub, 'u_ghost', { as: id.a1, body: { answersHash: hash } });
    expect(missingUnit.statusCode).toBe(404);
    expect((await decide(f, sub, 'u_applicant', { as: id.a1, formId: g.id })).statusCode).toBe(404);
    const ghost = await call('POST', `/v1/forms/${f.id}/submissions/${randomUUID()}/review/units/u_applicant/decisions`, { as: id.a1, body: { decision: 'approve', answersHash: hash }, headers: { 'idempotency-key': 'k' } });
    expect(ghost.statusCode).toBe(404);
    const foreign = await call('POST', `/v1/forms/${f.id}/submissions/${sub}/review/units/u_applicant/decisions`, {
      as: id.otherOwner,
      org: otherOrgId,
      body: { decision: 'approve', answersHash: hash },
      headers: { 'idempotency-key': 'k' },
    });
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(await decisionRows(sub)).toEqual([]);
    expect((await reviewRows(sub)).map((r) => r.state)).toEqual(['pending', 'pending']);
  });

  it('is for members who may check: a viewer or a creator gets 403 from the permission check, audited as a denied request', async () => {
    const f = await reviewedForm('Permission');
    const sub = await submit(f);
    for (const who of [id.viewer, id.creator]) {
      const res = await decide(f, sub, 'u_applicant', { as: who });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
      expect(await eventsOfRequest(res)).toEqual([expect.objectContaining({ action: 'request.authorize', outcome: 'denied', actorId: who, reason: 'missing_permission:submissions.review' })]);
    }
    expect(await decisionRows(sub)).toEqual([]);
  });
});

describe('the review detail', () => {
  interface Detail {
    submission: { id: string; formId: string; formTitle: string; status: string; versionId: string; versionNumber: number | null; locale: string };
    redacted: boolean;
    units: Array<{ unitId: string; name: string; state: string; order: number; groupId: string; groupName: string | null; yours: boolean; canDecide: boolean; blocked: boolean; answersHash: string | null; required: boolean; visibility: string }>;
    decisions: Array<{ id: string; unitId: string; round: number; decision: string; reasonCode: string | null; decidedAt: string; decidedBy: { userId: string; name: string | null } }>;
    fields: Array<{ id: string; value: string }>;
    answers: Record<string, unknown>;
    files: unknown[];
  }

  it('with own_unit, a checker of unit B (an editor, and an owner in group B too) holds no unit A answer anywhere in the response', async () => {
    const f = await reviewedForm('Redacted B');
    const sub = await submit(f);
    for (const [read, who] of [id.b1, id.ownerB].entries()) {
      const res = await detail(f, sub, { as: who });
      const body = await ok<Detail>(res);
      expect(body.redacted, who).toBe(true);
      // The unit’s own block, and the one no unit covers: exactly these answers, and no others.
      expect(body.fields.map((x) => x.id)).toEqual(['note', 'free']);
      expect(body.answers).toEqual({ note: short(NOTE_TEXT), free: short(FREE_TEXT) });
      expect(body.fields.map((x) => x.value)).toEqual([NOTE_TEXT, FREE_TEXT]);
      // One submission.viewed per read, naming the reader.
      const viewed = await events('submission.viewed', sub);
      expect(viewed, who).toHaveLength(read + 1);
      expect(viewed.at(-1), who).toMatchObject({ actorId: who, outcome: 'success', formId: f.id });
      // Nothing of unit A, in whatever form: not the key, not the text, not the addresses, not the hash.
      const text = res.body;
      for (const secret of [UNIT_A_TEXT, 'Asha', RESPONDENT, BACKUP, '"id":"name"', '"id":"email"', '"id":"backup"', await hashOf(sub, 'u_applicant')]) expect(text, `${who}: ${secret}`).not.toContain(secret);
      expect(body.units.map((u) => [u.unitId, u.answersHash === null])).toEqual([
        ['u_applicant', true],
        ['u_notes', false],
      ]);
      // computed (variables, fired rules) and what the server recorded about the request are never in this response.
      expect(Object.keys(body).sort()).toEqual(['answers', 'decisions', 'fields', 'files', 'redacted', 'submission', 'units']);
    }
  });

  it('a checker of unit A holds no unit B answer, and every read leaves a submission.viewed record', async () => {
    const f = await reviewedForm('Redacted A');
    const sub = await submit(f);
    const before = (await events('submission.viewed', sub)).length;
    const res = await detail(f, sub, { as: id.a1 });
    const body = await ok<Detail>(res);
    expect(body.fields.map((x) => x.id)).toEqual(['name', 'email', 'backup', 'free']);
    expect(Object.keys(body.answers).sort()).toEqual(['backup', 'email', 'free', 'name']);
    expect(res.body).not.toContain(NOTE_TEXT);
    expect(res.body).not.toContain('"note"');
    expect(body.units.find((u) => u.unitId === 'u_applicant')!.answersHash).toBe(await hashOf(sub, 'u_applicant'));
    // One record per read, naming the reader.
    await ok(await detail(f, sub, { as: id.a1 }));
    await ok(await detail(f, sub, { as: id.b1 }));
    const viewed = await events('submission.viewed', sub);
    expect(viewed).toHaveLength(before + 3);
    expect(viewed.slice(-3).map((e) => [e['actorId'], e['outcome'], e['formId']])).toEqual([
      [id.a1, 'success', f.id],
      [id.a1, 'success', f.id],
      [id.b1, 'success', f.id],
    ]);
  });

  it('lists a file only to the checker of the unit that holds it, and to a member in no group', async () => {
    const f = await reviewedForm('Files', { file: true });
    const sub = await submit(f);
    const a1 = await ok<Detail>(await detail(f, sub, { as: id.a1 }));
    expect(a1.files).toEqual([expect.objectContaining({ blockId: 'cv', name: 'cv.pdf', mime: 'application/pdf', purpose: 'file', masked: false, id: expect.any(String) })]);
    expect(a1.answers).toHaveProperty('cv');
    const b1 = await detail(f, sub, { as: id.b1 });
    const hidden = await ok<Detail>(b1);
    expect(hidden.files).toEqual([]);
    expect(hidden.answers).not.toHaveProperty('cv');
    expect(b1.body).not.toContain('cv.pdf');
    expect((await ok<Detail>(await detail(f, sub, { as: id.owner }))).files).toHaveLength(1);
  });

  it('a member in no review group sees the whole response, owners and admins and a viewer with submissions.read included', async () => {
    const f = await reviewedForm('Not redacted');
    const sub = await submit(f);
    for (const who of [id.owner, id.admin, id.viewer, id.bystander]) {
      const body = await ok<Detail>(await detail(f, sub, { as: who }));
      expect(body.redacted, who).toBe(false);
      expect(Object.keys(body.answers).sort(), who).toEqual(['backup', 'email', 'free', 'name', 'note']);
      expect(body.units.every((u) => u.answersHash !== null), who).toBe(true);
    }
  });

  it('a checker of a unit that was given to another group afterwards is still a checker of this response: redacted, and they still read their unit', async () => {
    const f = await reviewedForm('Reassigned');
    const sub = await submit(f);
    // From now on group B checks the applicant unit; this response keeps group A, which opened it.
    await saveSettings(f.id, [assign('u_applicant', { groupId: groupB }), assign('u_notes', { groupId: groupB, order: 2 })]);
    const body = await ok<Detail>(await detail(f, sub, { as: id.a1 }));
    expect(body.redacted).toBe(true);
    expect(Object.keys(body.answers).sort()).toEqual(['backup', 'email', 'free', 'name']);
    expect(body.units.find((u) => u.unitId === 'u_applicant')).toMatchObject({ yours: true, canDecide: true, groupName: 'Group A' });
    // And it can still be decided by them.
    await ok(await decide(f, sub, 'u_applicant', { as: id.a1 }));
    // Review switched off for new responses changes nothing for this one either.
    await saveSettings(f.id, [], { enabled: false });
    const off = await ok<Detail>(await detail(f, sub, { as: id.b1 }));
    expect(off.redacted).toBe(true);
    expect(Object.keys(off.answers).sort()).toEqual(['free', 'note']);
  });

  it('whole_submission checkers see everything, and own_unit wins for a member who holds both', async () => {
    const f = await reviewedForm('Whole', { units: [assign('u_applicant', { visibility: 'whole_submission' }), assign('u_notes', { groupId: groupB, order: 2 })] });
    const sub = await submit(f);
    expect((await ok<Detail>(await detail(f, sub, { as: id.a1 }))).redacted).toBe(false);
    expect((await ok<Detail>(await detail(f, sub, { as: id.b1 }))).redacted).toBe(true);
    // `both` is in A (whole_submission) and B (own_unit).
    expect((await ok<Detail>(await detail(f, sub, { as: id.both }))).redacted).toBe(true);
  });

  it('lists each unit with its state, group and whether the caller may decide it now; the four-eyes exclusions and the order show', async () => {
    const f = await reviewedForm('Units');
    const sub = await submit(f);
    const a1 = await ok<Detail>(await detail(f, sub, { as: id.a1 }));
    expect(a1.submission).toMatchObject({ id: sub, formId: f.id, formTitle: 'Units', status: 'pending_review', versionId: f.versionId, versionNumber: 1, locale: 'en-IN' });
    expect(a1.units).toEqual([
      expect.objectContaining({ unitId: 'u_applicant', name: 'Applicant', state: 'pending', order: 1, groupId: groupA, groupName: 'Group A', required: true, visibility: 'own_unit', yours: true, canDecide: true, blocked: false }),
      expect.objectContaining({ unitId: 'u_notes', name: 'Notes', state: 'pending', order: 2, groupId: groupB, yours: false, canDecide: false, blocked: true }),
    ]);
    // The respondent’s own address: a member of the group, but not for this response.
    const matching = await ok<Detail>(await detail(f, sub, { as: id.matching }));
    expect(matching.units[0]).toMatchObject({ yours: true, canDecide: false });
    // The checker of unit B: not theirs yet, because the applicant unit has to be approved first.
    const b1 = await ok<Detail>(await detail(f, sub, { as: id.b1 }));
    expect(b1.units[1]).toMatchObject({ yours: true, canDecide: false, blocked: true });
    await ok(await decide(f, sub, 'u_applicant', { as: id.a1 }));
    const after = await ok<Detail>(await detail(f, sub, { as: id.b1 }));
    expect(after.units.map((u) => [u.unitId, u.state, u.canDecide, u.blocked])).toEqual([
      ['u_applicant', 'approved', false, false],
      ['u_notes', 'pending', true, false],
    ]);
  });

  it('holds the decision history: who, when, which reason code and which round', async () => {
    const f = await reviewedForm('History', { units: [assign('u_applicant'), assign('u_notes', { groupId: groupB, order: 1, required: false })] });
    const sub = await submit(f);
    await ok(await decide(f, sub, 'u_notes', { as: id.b1, body: { decision: 'reject', reasonCode: 'incorrect' } }));
    await ok(await decide(f, sub, 'u_applicant', { as: id.a2 }));
    const body = await ok<Detail>(await detail(f, sub, { as: id.owner }));
    expect(body.decisions).toEqual([
      { id: expect.any(String), unitId: 'u_notes', round: 1, decision: 'reject', reasonCode: 'incorrect', decidedAt: expect.any(String), decidedBy: { userId: id.b1, name: 'Bala Checker' } },
      { id: expect.any(String), unitId: 'u_applicant', round: 1, decision: 'approve', reasonCode: null, decidedAt: expect.any(String), decidedBy: { userId: id.a2, name: 'Amrita Checker' } },
    ]);
    expect(Date.parse(body.decisions[0]!.decidedAt)).toBeLessThanOrEqual(Date.parse(body.decisions[1]!.decidedAt));
    // An optional unit that was rejected does not reject the response: it completed when the required one was approved.
    expect(body.submission.status).toBe('complete');
  });

  it('is for members who may check or read: 403 for a creator, 404 for another form, another org and an id that is not a response', async () => {
    const f = await reviewedForm('Detail access');
    const g = await reviewedForm('Detail access, the other form');
    const sub = await submit(f);
    const creator = await detail(f, sub, { as: id.creator });
    expect(creator.statusCode, creator.body).toBe(403);
    expect(await eventsOfRequest(creator)).toEqual([expect.objectContaining({ action: 'request.authorize', outcome: 'denied', actorId: id.creator, reason: 'missing_permission:submissions.review|submissions.read' })]);
    expect((await detail(g, sub, { as: id.owner })).statusCode).toBe(404);
    expect((await detail(f, sub, { as: id.otherOwner, org: otherOrgId })).statusCode).toBe(404);
    expect((await call('GET', `/v1/forms/${f.id}/submissions/not-a-uuid/review`, { as: id.owner })).statusCode).toBe(400);
    expect((await call('GET', `/v1/forms/${f.id}/submissions/${randomUUID()}/review`, { as: id.owner })).statusCode).toBe(404);
  });

  it('answers 200 with no units for a response that was never held, and still audits the read', async () => {
    const f = await publishDraft('Never held', (formId) => draftWith(formId, [fieldBlock('name', 'short_text')], 'Never held'));
    const res = await app.inject({
      method: 'POST',
      url: `/v1/p/${f.slug}/submissions`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { formVersionId: f.versionId, answers: { name: short('plain') }, fields: [], locale: 'en-IN' },
    });
    const { submissionId } = await ok<{ submissionId: string }>(res);
    const body = await ok<Detail>(await detail(f, submissionId, { as: id.owner }));
    expect(body).toMatchObject({ units: [], decisions: [], redacted: false, submission: { status: 'complete' } });
    expect(Object.keys(body.answers)).toEqual(['name']);
    expect(await events('submission.viewed', submissionId)).toHaveLength(1);
  });
});

describe('the review queue', () => {
  it('lists the open units of the groups the caller is in, with the form, unit, response, age and round and never an answer', async () => {
    const f = await reviewedForm('Queue contents');
    const sub = await submit(f);
    const res = await call('GET', `/v1/reviews/queue?formId=${f.id}`, { as: id.a1 });
    const body = await ok<{ items: QueueItem[]; nextCursor: string | null }>(res);
    expect(body.items).toEqual([
      { submissionId: sub, formId: f.id, formTitle: 'Queue contents', unitId: 'u_applicant', unitName: 'Applicant', round: 1, order: 1, required: true, receivedAt: expect.any(String), ageSeconds: expect.any(Number) },
    ]);
    expect(body.nextCursor).toBeNull();
    expect(body.items[0]!.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(body.items[0]!.ageSeconds).toBeLessThan(120);
    for (const text of [UNIT_A_TEXT, NOTE_TEXT, FREE_TEXT, RESPONDENT, BACKUP]) expect(res.body).not.toContain(text);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('never lists a unit whose lower-order required unit is pending, until it is approved', async () => {
    const f = await reviewedForm('Queue order');
    const sub = await submit(f);
    expect((await queueOf(id.b1, `?formId=${f.id}`)).items).toEqual([]);
    expect((await queueOf(id.ownerB, `?formId=${f.id}`)).items).toEqual([]);
    await ok(await decide(f, sub, 'u_applicant', { as: id.a1 }));
    expect((await queueOf(id.b1, `?formId=${f.id}`)).items.map((i) => [i.submissionId, i.unitId])).toEqual([[sub, 'u_notes']]);
    // And the approved unit has left the queue of group A.
    expect((await queueOf(id.a1, `?formId=${f.id}`)).items).toEqual([]);
  });

  it('never lists the units of a group the caller is not in: not an owner, an admin, or an editor in no group', async () => {
    const f = await reviewedForm('Queue groups');
    await submit(f);
    for (const who of [id.owner, id.admin, id.bystander]) expect((await queueOf(who, `?formId=${f.id}`)).items, who).toEqual([]);
    expect((await queueOf(id.b1, `?formId=${f.id}`)).items).toEqual([]);
    expect((await queueOf(id.a2, `?formId=${f.id}`)).items).toHaveLength(1);
  });

  it('leaves out what the four-eyes rule would refuse: the respondent’s own address, the maker, the last editor', async () => {
    const f = await reviewedForm('Queue four eyes');
    const own = await submit(f);
    const another = await submit(f, { email: OTHER_RESPONDENT });
    // `matching` is a checker of group A with the verified address the first respondent typed.
    expect((await queueOf(id.matching, `?formId=${f.id}`)).items.map((i) => i.submissionId)).toEqual([another]);
    expect((await queueOf(id.a1, `?formId=${f.id}`)).items.map((i) => i.submissionId).sort()).toEqual([own, another].sort());
    await owner.query(`update submission_reviews set maker_user_id = $2 where submission_id = $1 and unit_id = 'u_applicant'`, [another, id.a2]);
    expect((await queueOf(id.a2, `?formId=${f.id}`)).items.map((i) => i.submissionId)).toEqual([own]);
    await owner.query(`update submission_reviews set last_editor_id = $2 where submission_id = $1 and unit_id = 'u_applicant'`, [own, id.a2]);
    expect((await queueOf(id.a2, `?formId=${f.id}`)).items).toEqual([]);
  });

  it('with distinct checkers, leaves out a unit of a response the caller already decided another unit of', async () => {
    const f = await reviewedForm('Queue distinct', { distinct: true, units: [assign('u_applicant'), assign('u_notes', { groupId: groupB, order: 2 })] });
    const sub = await submit(f);
    await ok(await decide(f, sub, 'u_applicant', { as: id.both }));
    expect((await queueOf(id.both, `?formId=${f.id}`)).items).toEqual([]);
    expect((await queueOf(id.b1, `?formId=${f.id}`)).items.map((i) => i.unitId)).toEqual(['u_notes']);
  });

  it('leaves out units of a response that was settled, and every unit once it is rejected', async () => {
    const f = await reviewedForm('Queue settled');
    const sub = await submit(f);
    await ok(await decide(f, sub, 'u_applicant', { as: id.a1, body: { decision: 'reject', reasonCode: 'duplicate' } }));
    expect((await queueOf(id.b1, `?formId=${f.id}`)).items).toEqual([]);
    expect((await queueOf(id.a2, `?formId=${f.id}`)).items).toEqual([]);
  });

  it('filters by form, unit and age', async () => {
    const f = await reviewedForm('Queue filters one', { units: [assign('u_applicant'), assign('u_notes', { order: 1 })] });
    const g = await reviewedForm('Queue filters two');
    const s1 = await submit(f);
    const s2 = await submit(g);
    const all = (await queueOf(id.a2, '?limit=200')).items.map((i) => `${i.submissionId}:${i.unitId}`);
    for (const key of [`${s1}:u_applicant`, `${s1}:u_notes`, `${s2}:u_applicant`]) expect(all).toContain(key);
    expect((await queueOf(id.a2, `?formId=${f.id}`)).items.map((i) => `${i.submissionId}:${i.unitId}`).sort()).toEqual([`${s1}:u_applicant`, `${s1}:u_notes`]);
    expect((await queueOf(id.a2, `?formId=${f.id}&unitId=u_notes`)).items.map((i) => i.unitId)).toEqual(['u_notes']);
    expect((await queueOf(id.a2, `?formId=${g.id}&unitId=u_notes`)).items).toEqual([]);
    // Age: nothing is a day old yet; two days later it is, but not three.
    expect((await queueOf(id.a2, `?formId=${f.id}&age=1d`)).items).toEqual([]);
    skewMs = 2 * 24 * 60 * 60 * 1000 + 60_000;
    try {
      const aged = await queueOf(id.a2, `?formId=${f.id}&age=1d`);
      expect(aged.items).toHaveLength(2);
      expect(aged.items.every((i) => i.ageSeconds >= 2 * 24 * 60 * 60)).toBe(true);
      expect((await queueOf(id.a2, `?formId=${f.id}&age=3d`)).items).toEqual([]);
    } finally {
      skewMs = 0;
    }
    for (const bad of ['?formId=nope', '?age=2d', '?limit=0', '?limit=201', `?unitId=${'u'.repeat(65)}`]) expect((await call('GET', `/v1/reviews/queue${bad}`, { as: id.a2 })).statusCode, bad).toBe(400);
  });

  it('pages by a signed cursor: newest response first, no unit twice or skipped, and a cursor of another caller or filter is 400', async () => {
    const f = await reviewedForm('Queue pages');
    const subs: string[] = [];
    for (let i = 0; i < 5; i++) subs.push(await submit(f));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await queueOf(id.a2, `?formId=${f.id}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.submissionId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    // Newest first; ids are UUIDv7, so a response made in the same millisecond still sorts by its id.
    expect(seen).toEqual([...subs].sort().reverse());

    const first = await queueOf(id.a2, `?formId=${f.id}&limit=2`);
    const token = encodeURIComponent(first.nextCursor!);
    expect((await call('GET', `/v1/reviews/queue?formId=${f.id}&limit=2&cursor=${token}`, { as: id.a1 })).json()).toMatchObject({ code: 'INVALID_CURSOR' });
    expect((await call('GET', `/v1/reviews/queue?limit=2&cursor=${token}`, { as: id.a2 })).json()).toMatchObject({ code: 'INVALID_CURSOR' });
    expect((await call('GET', `/v1/reviews/queue?formId=${f.id}&cursor=c1.e30.AAAA`, { as: id.a2 })).statusCode).toBe(400);
    // The same caller and filters, another page size, carries on.
    expect((await call('GET', `/v1/reviews/queue?formId=${f.id}&limit=3&cursor=${token}`, { as: id.a2 })).statusCode).toBe(200);
  });

  it('is for members who may check: 403 for a viewer, a creator and an anonymous caller; another org’s checker sees nothing of this org', async () => {
    const f = await reviewedForm('Queue access');
    await submit(f);
    for (const who of [id.viewer, id.creator]) {
      const res = await call('GET', '/v1/reviews/queue', { as: who });
      expect(res.statusCode, who).toBe(403);
      expect(await eventsOfRequest(res)).toEqual([expect.objectContaining({ action: 'request.authorize', outcome: 'denied', reason: 'missing_permission:submissions.review' })]);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/reviews/queue' })).statusCode).toBe(401);
    for (const who of [id.otherOwner, id.otherEditor]) expect((await queueOf(who, '', otherOrgId)).items, who).toEqual([]);
    expect((await queueOf(id.otherOwner, `?formId=${f.id}`, otherOrgId)).items).toEqual([]);
  });
});
