import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPostgresSearchIndex } from '@form/adapters/search';
import { createDb, provision, txExecutor, uuidV7, uuidV7Time, withTenant, type DbHandle } from '@form/db';
import { toIsoInstant } from '@form/ports';
import type { FormDefinition } from '@form/schema';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig, type ApiConfig } from '../src/config.ts';
import { createFileStore, type FileStore } from '../src/files.ts';
import { searchDocFor } from '../src/submissions/search-doc.ts';
import { encrypted, labelled, sensitive } from '../src/submissions/test-fixtures.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const MASK = '••••••';

/**
 * Responses go into the monthly partitions the database made when it was provisioned (this month and three more), so
 * every moment these tests store is in next month: a fixed date would lose its partition as the calendar moves on, and a
 * runner whose clock is a few hours off the database's still lands inside the partitions.
 */
const NEXT_MONTH = (() => {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
})();
/** A moment of day `day` (1 to 28) of next month, UTC. */
const on = (day: number, hour = 0, minute = 0, second = 0, ms = 0): Date => new Date(Date.UTC(NEXT_MONTH.year, NEXT_MONTH.month, day, hour, minute, second, ms));
const query = (date: Date): string => encodeURIComponent(date.toISOString());

type Block = ReturnType<typeof fieldBlock>;

let app: FastifyInstance;
let config: ApiConfig;
let owner: pg.Pool;
let appDb: DbHandle;
let filesDir: string;
let files: FileStore;
let orgId: string;
let userId: string;
let creatorId: string;
let viewerId: string;
let outsiderOrgId: string;
let outsiderId: string;
/** A published form with the plain fields `name` and `city`, and its live version. */
let formId: string;
let versionId: string;

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_submissions');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  appDb = createDb(urls.fr_app, { max: 2 });
  filesDir = await mkdtemp(path.join(tmpdir(), 'fr-submissions-'));
  files = createFileStore(filesDir);
  [orgId, userId, creatorId, viewerId, outsiderOrgId, outsiderId] = Array.from({ length: 6 }, () => randomUUID()) as [string, string, string, string, string, string];
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2), ($3, $4, $4)', [orgId, 'inbox', outsiderOrgId, 'elsewhere']);
  for (const [id, who] of [[userId, 'owner'], [creatorId, 'creator'], [viewerId, 'viewer'], [outsiderId, 'outsider']] as const) {
    await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [id, `${who}@inbox.test`]);
  }
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3), ($1, $4, $5), ($1, $6, $7), ($8, $9, $3)', [
    orgId, userId, 'owner', creatorId, 'creator', viewerId, 'viewer', outsiderOrgId, outsiderId,
  ]);

  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  config = parsed.config;
  // The composition root's wiring (`main.ts`): the Postgres adapter is the deployment's search index.
  app = await buildApp(config, { underPressure: false, files, searchIndex: createPostgresSearchIndex });
  ({ id: formId, versionId } = await publish(userId, 'Contact'));
});

afterAll(async () => {
  await app?.close();
  await appDb?.close();
  await owner?.end();
  if (filesDir) await rm(filesDir, { recursive: true, force: true });
});

const as = (user: string, org = orgId) => ({ 'x-fr-dev-user': user, 'x-fr-org': org, ...BROWSER });
const plainFields = () => [fieldBlock('name', 'short_text'), fieldBlock('city', 'short_text')];

async function publish(user: string, title: string, blocks: Block[] = plainFields()): Promise<{ id: string; versionId: string }> {
  const { id } = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(user), payload: { title } })).json<{ id: string }>();
  expect((await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...as(user), 'if-match': '0' }, payload: { draft: draftWith(id, blocks, title) } })).statusCode).toBe(200);
  return { id, versionId: await goLive(user, id) };
}

async function goLive(user: string, id: string): Promise<string> {
  const live = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(user), payload: {} });
  expect(live.statusCode, live.body).toBe(200);
  return live.json<{ versionId: string }>().versionId;
}

/** Publishes the next version of a form with new blocks (its draft is at revision `rev`). */
async function republish(user: string, id: string, blocks: Block[], rev: number, title = 'Contact'): Promise<string> {
  expect((await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...as(user), 'if-match': String(rev) }, payload: { draft: draftWith(id, blocks, title) } })).statusCode).toBe(200);
  return goLive(user, id);
}

const short = (value: string) => ({ type: 'short_text', value });

interface Stored {
  id: string;
  receivedAt: Date;
}

/**
 * A response stored the way the submit route stores it, as the schema owner (which may name any column): filed under
 * `version` of `form`, received at `at`, with a UUIDv7 id made from that moment (two rows of one millisecond get two ids).
 */
async function store(
  answers: Record<string, unknown>,
  o: { form?: string; version?: string; at?: Date; locale?: string; trashed?: boolean; archived?: boolean; read?: boolean; starred?: boolean; status?: string; meta?: Record<string, unknown> } = {},
): Promise<Stored> {
  const id = uuidV7(o.at ?? new Date());
  const receivedAt = uuidV7Time(id)!;
  await owner.query(
    `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta, trashed_at, archived_at, read, starred)
     select $1, $2, org_id, form_id, id, decode(content_hash, 'hex'), 0, $7, $3, '{}', $4, case when $5 then now() end, case when $6 then now() end, $8, $9 from form_versions where id = $10`,
    [id, receivedAt, JSON.stringify(answers), JSON.stringify({ locale: o.locale ?? 'en-IN', ...o.meta }), o.trashed ?? false, o.archived ?? false, o.status ?? 'complete', o.read ?? false, o.starred ?? false, o.version ?? versionId],
  );
  return { id, receivedAt };
}

/** The search index, as the submit pipeline will use it: the adapter, writing as a system job. */
const searchIndex = () =>
  createPostgresSearchIndex({ inTenant: (org, fn) => withTenant(appDb.db, { orgId: org, actor: 'system', requestId: 'seed' }, (tx) => fn(txExecutor(tx))) });

/** `store`, and the response's search document as `searchDocFor` makes it. */
async function storeIndexed(form: string, version: string, answers: Record<string, unknown>, o: { at?: Date; trashed?: boolean } = {}): Promise<Stored> {
  const row = await store(answers, { form, version, ...o });
  const { rows } = await owner.query<{ definition: FormDefinition; taint: Record<string, never> | null }>("select definition, compiled -> 'taint' as taint from form_versions where id = $1", [version]);
  const text = searchDocFor({ definition: rows[0]!.definition, compiled: { taint: rows[0]!.taint ?? {} } }, answers as never);
  await searchIndex().upsert(orgId, [{ submissionId: row.id, receivedAt: toIsoInstant(row.receivedAt), formId: form, locale: 'en-IN', text }]);
  return row;
}

interface GridBody {
  columns: Array<{ id: string; label: string; type: string }>;
  items: Array<{ id: string; receivedAt: string; status: string; read: boolean; starred: boolean; archivedAt: string | null; trashedAt: string | null; versionNumber: number | null; cells: Record<string, string>; masked: string[] }>;
  nextCursor: string | null;
}

async function grid(form: string, query = '', user = userId, org = orgId) {
  const res = await app.inject({ url: `/v1/forms/${form}/submissions${query ? `?${query}` : ''}`, headers: as(user, org) });
  return { res, body: res.statusCode === 200 ? res.json<GridBody>() : null };
}

const idsOf = (body: GridBody | null) => (body?.items ?? []).map((i) => i.id);

/** The audit events a request left (`audit_pending` holds them until `audit.chain` runs, which these tests do not start). */
async function auditOf(res: { headers: Record<string, unknown> }, action: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'requestId' = $2 and event->>'action' = $3 order by id`, [
    orgId,
    String(res.headers['x-request-id']),
    action,
  ]);
  return rows.map((r) => r.event);
}

const count = async (sql: string, args: unknown[]) => (await owner.query<{ n: number }>(sql, args)).rows[0]!.n;

describe('the grid', () => {
  it('has no route that creates a submission: members read responses, only the published page writes them', async () => {
    const before = await count('select count(*)::int as n from submissions where form_id = $1', [formId]);
    for (const headers of [as(userId), {}]) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/forms/${formId}/submissions`,
        headers,
        payload: { answers: { name: short('forged') }, fields: [{ key: 'approval', label: 'Approved by HR', value: 'Yes' }], locale: 'en-IN' },
      });
      expect(res.statusCode).toBe(404);
    }
    expect(await count('select count(*)::int as n from submissions where form_id = $1', [formId])).toBe(before);
  });

  it('lists the newest first by the moment received, leaves the archive and the trash out of the inbox, and says what each row is', async () => {
    const f = await publish(userId, 'Order');
    const older = await store({ name: short('older') }, { form: f.id, version: f.versionId, at: on(3, 10) });
    const newest = await store({ name: short('newest') }, { form: f.id, version: f.versionId, at: on(14, 8, 15, 30, 250), read: true, starred: true });
    const middle = await store({ name: short('middle') }, { form: f.id, version: f.versionId, at: on(9, 23, 59, 59, 999) });
    await store({ name: short('trashed') }, { form: f.id, version: f.versionId, at: on(15, 1), trashed: true });
    await store({ name: short('archived') }, { form: f.id, version: f.versionId, at: on(15, 2), archived: true });
    const { res, body } = await grid(f.id);
    expect(res.statusCode).toBe(200);
    expect(body!.items.map((i) => [i.id, i.receivedAt])).toEqual([
      [newest.id, on(14, 8, 15, 30, 250).toISOString()],
      [middle.id, on(9, 23, 59, 59, 999).toISOString()],
      [older.id, on(3, 10).toISOString()],
    ]);
    expect(body!.items[0]).toMatchObject({ status: 'complete', read: true, starred: true, archivedAt: null, trashedAt: null, versionNumber: 1, cells: { name: 'newest' }, masked: [] });
    expect(body!.items[1]).toMatchObject({ read: false, starred: false });
    expect(body!.nextCursor).toBeNull();
    expect(body!.columns).toEqual([
      { id: 'name', key: 'name', label: 'name', type: 'short_text' },
      { id: 'city', key: 'city', label: 'city', type: 'short_text' },
    ]);
    expect((await grid(f.id, 'view=archived')).body!.items.map((i) => i.cells.name)).toEqual(['archived']);
    expect((await grid(f.id, 'view=trash')).body!.items.map((i) => i.cells.name)).toEqual(['trashed']);
  });

  it('filters by date, status, read and starred, and the filters combine', async () => {
    const f = await publish(userId, 'Filtered');
    const row = (name: string, day: number, o: Parameters<typeof store>[1] = {}) => store({ name: short(name) }, { form: f.id, version: f.versionId, at: on(day, 12), ...o });
    await row('a', 1);
    await row('b', 2, { read: true });
    await row('c', 3, { starred: true, status: 'spam' });
    await row('d', 4, { read: true, starred: true });
    const names = async (query: string) => (await grid(f.id, query)).body!.items.map((i) => i.cells.name).reverse();
    expect(await names('')).toEqual(['a', 'b', 'c', 'd']);
    expect(await names('read=true')).toEqual(['b', 'd']);
    expect(await names('read=false')).toEqual(['a', 'c']);
    expect(await names('starred=true')).toEqual(['c', 'd']);
    expect(await names('status=spam')).toEqual(['c']);
    expect(await names('read=true&starred=true')).toEqual(['d']);
    expect(await names(`from=${query(on(2))}&to=${query(on(3, 23, 59, 59))}`)).toEqual(['b', 'c']);
    expect(await names(`from=${query(on(5))}`)).toEqual([]);
    expect((await grid(f.id, 'status=nonsense')).res.statusCode).toBe(400);
    expect((await grid(f.id, `from=${query(on(3))}&to=${query(on(2))}`)).res.statusCode).toBe(400);
  });

  it('shows the columns of every version of the form: a field only version 1 had and one only version 2 has', async () => {
    const f = await publish(userId, 'Two versions', [labelled(fieldBlock('name', 'short_text'), 'Name'), fieldBlock('fax', 'short_text')]);
    const v2 = await republish(userId, f.id, [labelled(fieldBlock('name', 'short_text'), 'Full name'), fieldBlock('mail', 'email')], 1, 'Two versions');
    const onV1 = await store({ name: short('Asha'), fax: short('020 555 0100') }, { form: f.id, version: f.versionId, at: on(1, 10) });
    const onV2 = await store({ name: short('Ravi'), mail: { type: 'email', value: { address: 'ravi@example.test' } } }, { form: f.id, version: v2, at: on(2, 10) });
    const { body } = await grid(f.id);
    // The union, keyed by block id, labelled and ordered by the newest version; the field only version 1 had comes last.
    expect(body!.columns.map((c) => [c.id, c.label, c.type])).toEqual([
      ['name', 'Full name', 'short_text'],
      ['mail', 'mail', 'email'],
      ['fax', 'fax', 'short_text'],
    ]);
    const byId = Object.fromEntries(body!.items.map((i) => [i.id, i]));
    expect(byId[onV1.id]).toMatchObject({ versionNumber: 1, cells: { name: 'Asha', fax: '020 555 0100' } });
    expect(byId[onV2.id]).toMatchObject({ versionNumber: 2, cells: { name: 'Ravi', mail: 'ravi@example.test' } });
    expect(Object.keys(byId[onV1.id]!.cells)).not.toContain('mail');
    expect(Object.keys(byId[onV2.id]!.cells)).not.toContain('fax');
  });

  it('pages by cursor and returns each row once, in order, even when rows share a millisecond', async () => {
    const f = await publish(userId, 'Paged');
    const stored: Stored[] = [];
    for (let i = 0; i < 7; i += 1) {
      // Pairs of rows in the same millisecond, so the id has to break the tie.
      stored.push(await store({ name: short(`row ${i}`) }, { form: f.id, version: f.versionId, at: on(1 + Math.floor(i / 2), 9) }));
    }
    const expected = [...stored].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || (a.id < b.id ? 1 : -1)).map((s) => s.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { res, body } = await grid(f.id, `limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.statusCode, res.body).toBe(200);
      seen.push(...idsOf(body));
      cursor = body!.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(7);

    // A row that arrives between two pages is not on the next one (it is newer than the cursor), and nothing is skipped.
    const first = (await grid(f.id, 'limit=3')).body!;
    const late = await store({ name: short('late') }, { form: f.id, version: f.versionId, at: on(28) });
    const second = (await grid(f.id, `limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`)).body!;
    expect([...idsOf(first), ...idsOf(second)]).toEqual(expected.slice(0, 6));
    expect(idsOf(second)).not.toContain(late.id);
  });

  it('refuses a cursor that was edited, belongs to another query, or is not one, and does not fall back to the first page', async () => {
    const f = await publish(userId, 'Cursors');
    for (let i = 0; i < 3; i += 1) await store({ name: short(`row ${i}`) }, { form: f.id, version: f.versionId, at: on(1 + i) });
    const { nextCursor } = (await grid(f.id, 'limit=1')).body!;
    expect(nextCursor).toBeTruthy();
    const problem = async (query: string) => {
      const { res } = await grid(f.id, query);
      return [res.statusCode, res.json<{ code: string }>().code];
    };
    expect(await problem(`limit=1&cursor=${encodeURIComponent(`${nextCursor!.slice(0, -3)}abc`)}`)).toEqual([400, 'INVALID_CURSOR']);
    expect(await problem('cursor=garbage')).toEqual([400, 'INVALID_CURSOR']);
    // Signed for the inbox: not good for the trash, a filter, or a search.
    expect(await problem(`view=trash&cursor=${encodeURIComponent(nextCursor!)}`)).toEqual([400, 'INVALID_CURSOR']);
    expect(await problem(`read=false&cursor=${encodeURIComponent(nextCursor!)}`)).toEqual([400, 'INVALID_CURSOR']);
    expect(await problem(`q=row&cursor=${encodeURIComponent(nextCursor!)}`)).toEqual([400, 'INVALID_CURSOR']);
    // Another form, another member.
    const { res: other } = await grid(formId, `cursor=${encodeURIComponent(nextCursor!)}`);
    expect(other.statusCode).toBe(400);
    const viewerRes = await app.inject({ url: `/v1/forms/${f.id}/submissions?cursor=${encodeURIComponent(nextCursor!)}`, headers: as(viewerId) });
    expect(viewerRes.statusCode).toBe(400);
  });

  it('leaves one audit record per page with every id shown, and one for a detail view', async () => {
    const f = await publish(userId, 'Audited');
    const rows = [];
    for (let i = 0; i < 5; i += 1) rows.push(await store({ name: short(`row ${i}`) }, { form: f.id, version: f.versionId, at: on(1 + i) }));

    const first = await grid(f.id, 'limit=3');
    const shown = idsOf(first.body);
    expect(shown).toHaveLength(3);
    const records = await auditOf(first.res, 'submission.page_viewed');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ actorKind: 'user', actorId: userId, formId: f.id, resourceId: f.id, outcome: 'success', metadata: { ids: shown, count: 3, page: 1, filtered: false } });
    // Who and from where, the way the file downloads record it: a session-less test caller has no session id, and the address is a hash.
    expect(records[0]!.actorIpHash).toMatch(/^[0-9a-f]+$/);

    const second = await grid(f.id, `limit=3&cursor=${encodeURIComponent(first.body!.nextCursor!)}&read=false`).then((r) => r);
    // The cursor was signed for an unfiltered query, so this is a refusal, which reads nothing and leaves no page record.
    expect(second.res.statusCode).toBe(400);
    expect(await auditOf(second.res, 'submission.page_viewed')).toHaveLength(0);
    const next = await grid(f.id, `limit=3&cursor=${encodeURIComponent(first.body!.nextCursor!)}`);
    expect(await auditOf(next.res, 'submission.page_viewed')).toMatchObject([{ metadata: { ids: idsOf(next.body), count: 2, page: 2, filtered: false } }]);
    const filtered = await grid(f.id, 'read=false');
    expect(await auditOf(filtered.res, 'submission.page_viewed')).toMatchObject([{ metadata: { count: 5, filtered: true } }]);

    const detail = await app.inject({ url: `/v1/forms/${f.id}/submissions/${rows[0]!.id}`, headers: as(userId) });
    expect(detail.statusCode).toBe(200);
    expect(await auditOf(detail, 'submission.viewed')).toMatchObject([{ actorId: userId, resourceType: 'submission', resourceId: rows[0]!.id, formId: f.id, outcome: 'success' }]);
    // A response that is not there is not a read.
    const missing = await app.inject({ url: `/v1/forms/${f.id}/submissions/${uuidV7(new Date())}`, headers: as(userId) });
    expect(missing.statusCode).toBe(404);
    expect(await auditOf(missing, 'submission.viewed')).toHaveLength(0);
  });

  it('does not show the grid of a form that is not in the org, and a 404 leaves no page record', async () => {
    const res = await app.inject({ url: `/v1/forms/${randomUUID()}/submissions`, headers: as(userId) });
    expect(res.statusCode).toBe(404);
    expect(await auditOf(res, 'submission.page_viewed')).toHaveLength(0);
  });
});

describe('search', () => {
  let form: { id: string; versionId: string };
  let other: { id: string; versionId: string };

  beforeAll(async () => {
    const blocks = () => [labelled(fieldBlock('name', 'short_text'), 'Name'), labelled(sensitive(fieldBlock('pan', 'short_text')), 'PAN'), labelled(encrypted(fieldBlock('phone', 'short_text')), 'Phone'), fieldBlock('city', 'short_text')];
    form = await publish(userId, 'Searchable', blocks());
    other = await publish(userId, 'Another form of the org', blocks());
  });

  const answersOf = (name: string, pan: string, phone: string, city: string) => ({ name: short(name), pan: short(pan), phone: short(phone), city: short(city) });

  it('finds a plain field’s text, finds nothing for a sensitive or encrypted field’s text, and never reaches another form of the org', async () => {
    const asha = await storeIndexed(form.id, form.versionId, answersOf('Asha Kulkarni', 'ABCDE1234F', '9876543210', 'Pune'), { at: on(2, 10) });
    await storeIndexed(form.id, form.versionId, answersOf('Ravi Sharma', 'ZZZZZ9999Z', '9123456780', 'Mumbai'), { at: on(3, 10) });
    // The same words on another form of the same org.
    const twin = await storeIndexed(other.id, other.versionId, answersOf('Asha Kulkarni', 'ABCDE1234F', '9876543210', 'Pune'), { at: on(4, 10) });

    expect(idsOf((await grid(form.id, 'q=Kulkarni')).body)).toEqual([asha.id]);
    expect(idsOf((await grid(form.id, 'q=pune')).body)).toEqual([asha.id]);
    // What is stored for the sensitive and encrypted fields cannot be found, whole or as the words of it.
    for (const text of ['ABCDE1234F', 'abcde1234f', 'ZZZZZ9999Z', '9876543210', '9123456780']) {
      const { res, body } = await grid(form.id, `q=${text}`);
      expect(res.statusCode, text).toBe(200);
      expect(body!.items, text).toEqual([]);
    }
    // Not in the index at all, so no query reaches it: the document of the row holds the plain text only.
    const doc = await owner.query<{ doc: string }>('select doc::text as doc from submission_search where submission_id = $1', [asha.id]);
    expect(doc.rows[0]!.doc).toContain('kulkarni');
    expect(doc.rows[0]!.doc).not.toMatch(/abcde|9876/);

    // Another form's row has the same words but is not this form's hit, and the other form finds its own.
    expect(idsOf((await grid(form.id, 'q=Kulkarni')).body)).not.toContain(twin.id);
    expect(idsOf((await grid(other.id, 'q=Kulkarni')).body)).toEqual([twin.id]);
    // And a member of another org finds nothing of it, nor does the form exist for them.
    expect((await grid(form.id, 'q=Kulkarni', outsiderId, outsiderOrgId)).res.statusCode).toBe(404);
  });

  it('masks the sensitive and encrypted values in the grid, and says which cells are masked', async () => {
    const { body } = await grid(form.id);
    const row = body!.items.find((i) => i.cells.name === 'Asha Kulkarni')!;
    expect(row.cells).toEqual({ name: 'Asha Kulkarni', pan: MASK, phone: MASK, city: 'Pune' });
    expect(row.masked).toEqual(['pan', 'phone']);
    expect(JSON.stringify(body)).not.toMatch(/ABCDE1234F|9876543210|ZZZZZ9999Z/);
  });

  it('intersects the hits with the view and the filters, and pages through them by cursor', async () => {
    const f = await publish(userId, 'Many hits');
    const rows: Stored[] = [];
    for (let i = 0; i < 7; i += 1) rows.push(await storeIndexed(f.id, f.versionId, { name: short(`needle ${i}`), city: short('Delhi') }, { at: on(1 + i, 8) }));
    await storeIndexed(f.id, f.versionId, { name: short('haystack') }, { at: on(20, 8) });
    const all = idsOf((await grid(f.id, 'q=needle&limit=100')).body);
    expect([...all].sort()).toEqual(rows.map((r) => r.id).sort());

    // Pages of three, by the signed cursor: every hit once.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { res, body } = await grid(f.id, `q=needle&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(body!.items.length).toBeLessThanOrEqual(3);
      seen.push(...idsOf(body));
      cursor = body!.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual(all);

    // Filters: a trashed or archived hit is not in the inbox, and is in its own view; read/starred narrow the hits.
    await app.inject({ method: 'POST', url: `/v1/forms/${f.id}/submissions/bulk`, headers: as(userId), payload: { ids: [rows[0]!.id, rows[1]!.id], action: 'trash' } });
    await app.inject({ method: 'POST', url: `/v1/forms/${f.id}/submissions/bulk`, headers: as(userId), payload: { ids: [rows[2]!.id], action: 'archive' } });
    await app.inject({ method: 'POST', url: `/v1/forms/${f.id}/submissions/bulk`, headers: as(userId), payload: { ids: [rows[3]!.id], action: 'star' } });
    expect(new Set(idsOf((await grid(f.id, 'q=needle&limit=100')).body))).toEqual(new Set([rows[3]!.id, rows[4]!.id, rows[5]!.id, rows[6]!.id]));
    expect(new Set(idsOf((await grid(f.id, 'q=needle&view=trash')).body))).toEqual(new Set([rows[0]!.id, rows[1]!.id]));
    expect(idsOf((await grid(f.id, 'q=needle&view=archived')).body)).toEqual([rows[2]!.id]);
    expect(idsOf((await grid(f.id, 'q=needle&starred=true')).body)).toEqual([rows[3]!.id]);
    // A page can be short while there is more: the filter dropped hits. Following the cursor still finds all of them.
    const filteredSeen: string[] = [];
    cursor = null;
    pages = 0;
    do {
      const { body } = await grid(f.id, `q=needle&limit=1&cursor=${cursor ? encodeURIComponent(cursor) : ''}`.replace('&cursor=', cursor ? '&cursor=' : ''));
      filteredSeen.push(...idsOf(body));
      cursor = body!.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    expect(new Set(filteredSeen)).toEqual(new Set([rows[3]!.id, rows[4]!.id, rows[5]!.id, rows[6]!.id]));
    expect(filteredSeen).toHaveLength(4);
    // The page's audit record carries the search as a filter, never the words.
    const searched = await grid(f.id, 'q=needle');
    const [record] = await auditOf(searched.res, 'submission.page_viewed');
    expect(record).toMatchObject({ metadata: { filtered: true } });
    expect(JSON.stringify(record)).not.toContain('needle');
  });

  it('answers 503 to a search, and to delete forever, on a server built without a search index, and changes nothing', async () => {
    // What `buildApp` does when the composition root passes no index: refuse, before anything is read, recorded or removed.
    const bare = await buildApp(config, { underPressure: false, files });
    try {
      const trashed = await store({ name: short('bare') }, { form: form.id, version: form.versionId, trashed: true });
      const found = await bare.inject({ url: `/v1/forms/${form.id}/submissions?q=anything`, headers: as(userId) });
      expect(found.statusCode).toBe(503);
      expect(found.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(await auditOf(found, 'submission.page_viewed')).toHaveLength(0);
      const gone = await bare.inject({ method: 'POST', url: `/v1/forms/${form.id}/submissions/bulk`, headers: as(userId), payload: { ids: [trashed.id], action: 'delete' } });
      expect(gone.statusCode).toBe(503);
      expect(await count('select count(*)::int as n from submissions where id = $1', [trashed.id])).toBe(1);
      // The grid without a search, and the other bulk actions, do not need the index.
      expect((await bare.inject({ url: `/v1/forms/${form.id}/submissions`, headers: as(userId) })).statusCode).toBe(200);
      expect((await bare.inject({ method: 'POST', url: `/v1/forms/${form.id}/submissions/bulk`, headers: as(userId), payload: { ids: [trashed.id], action: 'restore' } })).statusCode).toBe(200);
    } finally {
      await bare.close();
    }
  });

  it('treats an empty search box as no search', async () => {
    const { res, body } = await grid(form.id, 'q=');
    expect(res.statusCode).toBe(200);
    expect(body!.items.length).toBeGreaterThanOrEqual(2);
  });
});

describe('one response', () => {
  it('returns its fields, answers, version, meta and files, and masks what is sensitive', async () => {
    const f = await publish(userId, 'Detail', [labelled(fieldBlock('name', 'short_text'), 'Name'), labelled(sensitive(fieldBlock('pan', 'short_text')), 'PAN'), fieldBlock('cv', 'file_upload'), labelled(sensitive(fieldBlock('scan', 'file_upload')), 'ID scan')]);
    const row = await store(
      { name: short('Asha'), pan: short('ABCDE1234F') },
      { form: f.id, version: f.versionId, locale: 'hi-IN', meta: { pageUrl: 'https://form.test/f/x', ipHash: 'aa'.repeat(16), uaHash: 'bb'.repeat(16), versionNumber: 1 } },
    );
    const cv = randomUUID();
    const secret = randomUUID();
    for (const [id, block, name] of [[cv, 'cv', 'cv.pdf'], [secret, 'scan', 'passport.pdf']] as const) {
      await owner.query(
        `insert into form_files (id, org_id, form_id, block_id, name, mime, size_bytes, sha256, purpose, submission_id, submission_received_at)
         values ($1, $2, $3, $4, $5, 'application/pdf', 12, $6, 'file', $7, $8)`,
        [id, orgId, f.id, block, name, 'a'.repeat(64), row.id, row.receivedAt],
      );
    }
    const res = await app.inject({ url: `/v1/forms/${f.id}/submissions/${row.id}`, headers: as(userId) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      id: row.id,
      formId: f.id,
      receivedAt: row.receivedAt.toISOString(),
      status: 'complete',
      read: false,
      starred: false,
      archivedAt: null,
      trashedAt: null,
      versionId: f.versionId,
      versionNumber: 1,
      locale: 'hi-IN',
      meta: { locale: 'hi-IN', pageUrl: 'https://form.test/f/x', versionNumber: 1 },
      fields: [
        { id: 'name', key: 'name', label: 'Name', type: 'short_text', value: 'Asha', masked: false },
        { id: 'pan', key: 'pan', label: 'PAN', type: 'short_text', value: MASK, masked: true },
      ],
      answers: { name: short('Asha'), pan: { type: 'short_text', masked: true } },
      files: expect.arrayContaining([
        { id: cv, blockId: 'cv', name: 'cv.pdf', mime: 'application/pdf', sizeBytes: 12, purpose: 'file', masked: false },
        // A file in a sensitive field is listed, neither named nor fetchable from here.
        { id: null, blockId: 'scan', name: MASK, mime: '', sizeBytes: null, purpose: 'file', masked: true },
      ]),
    });
    expect(res.body).not.toMatch(/ABCDE1234F|passport|aaaaaaaa/);
    expect(res.json<{ files: unknown[] }>().files).toHaveLength(2);
  });

  it('shows each response with the labels of the version it was received on, not the live one', async () => {
    const f = await publish(userId, 'Relabelled');
    const second = await republish(userId, f.id, [labelled(fieldBlock('name', 'short_text'), 'Full name'), fieldBlock('city', 'short_text')], 1, 'Relabelled');
    const onFirst = await store({ name: short('Asha'), city: short('Pune') }, { form: f.id, version: f.versionId });
    const onSecond = await store({ name: short('Ravi') }, { form: f.id, version: second });
    const detail = async (id: string) => (await app.inject({ url: `/v1/forms/${f.id}/submissions/${id}`, headers: as(userId) })).json<{ versionNumber: number; fields: Array<{ id: string; label: string; value: string }> }>();
    expect(await detail(onFirst.id)).toMatchObject({ versionNumber: 1, fields: [{ id: 'name', label: 'name', value: 'Asha' }, { id: 'city', label: 'city', value: 'Pune' }] });
    expect(await detail(onSecond.id)).toMatchObject({ versionNumber: 2, fields: [{ id: 'name', label: 'Full name', value: 'Ravi' }] });
  });

  it('finds one submission by id and its own moment, and nothing for an id that is not a UUIDv7 or is on another form', async () => {
    const mine = await store({ name: short('Asha') });
    const other = await publish(userId, 'Another form');
    expect((await app.inject({ url: `/v1/forms/${formId}/submissions/${mine.id}`, headers: as(userId) })).statusCode).toBe(200);
    // Not a UUIDv7: no submission can have it, and the database is never asked for its moment (that would be a 500).
    for (const id of [randomUUID(), '00000000-0000-0000-0000-000000000000']) {
      expect((await app.inject({ url: `/v1/forms/${formId}/submissions/${id}`, headers: as(userId) })).statusCode, id).toBe(404);
    }
    expect((await app.inject({ url: `/v1/forms/${formId}/submissions/${uuidV7(new Date())}`, headers: as(userId) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/v1/forms/${other.id}/submissions/${mine.id}`, headers: as(userId) })).statusCode).toBe(404);
  });
});

describe('the inbox flags', () => {
  it('marks a response read and starred, once: a flag already set writes and records nothing', async () => {
    const row = await store({ name: short('Asha') });
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/v1/forms/${formId}/submissions/${row.id}`, headers: as(userId), payload });
    const first = await patch({ read: true });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ id: row.id, read: true, starred: false });
    expect(await auditOf(first, 'submission.updated')).toMatchObject([{ actorId: userId, resourceType: 'submission', resourceId: row.id, formId, metadata: { ops: ['mark_read'], count: 1, ids: [row.id] } }]);

    const again = await patch({ read: true });
    expect(again.json()).toEqual({ id: row.id, read: true, starred: false });
    expect(await auditOf(again, 'submission.updated')).toHaveLength(0);

    const both = await patch({ read: false, starred: true });
    expect(both.json()).toEqual({ id: row.id, read: false, starred: true });
    expect(await auditOf(both, 'submission.updated')).toMatchObject([{ metadata: { ops: ['mark_unread', 'star'] } }]);
    expect((await grid(formId)).body!.items.find((i) => i.id === row.id)).toMatchObject({ read: false, starred: true });
  });

  it('refuses a body that changes nothing or names another column, and answers 404 for a response that is not there', async () => {
    const row = await store({ name: short('Asha') });
    const patch = (id: string, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/v1/forms/${formId}/submissions/${id}`, headers: as(userId), payload });
    for (const bad of [{}, { read: 'yes' }, { trashedAt: null }, { read: true, answers: { name: short('edited') } }]) expect((await patch(row.id, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    expect((await patch(uuidV7(new Date()), { read: true })).statusCode).toBe(404);
    expect((await patch(randomUUID(), { read: true })).statusCode).toBe(404);
    const stored = await owner.query('select answers, read, starred from submissions where id = $1', [row.id]);
    expect(stored.rows[0]).toMatchObject({ answers: { name: short('Asha') }, read: false, starred: false });
  });
});

describe('bulk actions', () => {
  const bulk = (form: string, ids: string[], action: string, user = userId) => app.inject({ method: 'POST', url: `/v1/forms/${form}/submissions/bulk`, headers: as(user), payload: { ids, action } });

  it('marks read and starred, archives, trashes and restores, and moves rows between the views', async () => {
    const f = await publish(userId, 'Bulk');
    const [a, b, c] = [await store({ name: short('a') }, { form: f.id, version: f.versionId, at: on(1) }), await store({ name: short('b') }, { form: f.id, version: f.versionId, at: on(2) }), await store({ name: short('c') }, { form: f.id, version: f.versionId, at: on(3) })];
    const view = async (v: string) => (await grid(f.id, `view=${v}`)).body!.items.map((i) => i.cells.name).reverse();

    expect((await bulk(f.id, [a.id, b.id], 'mark_read')).json()).toEqual({ action: 'mark_read', requested: 2, changed: 2, unchanged: 0, missing: 0, removedFiles: 0 });
    expect((await bulk(f.id, [a.id, c.id], 'mark_read')).json()).toMatchObject({ changed: 1, unchanged: 1 });
    expect((await grid(f.id, 'read=true')).body!.items).toHaveLength(3);
    expect((await bulk(f.id, [a.id], 'mark_unread')).json()).toMatchObject({ changed: 1 });
    expect((await bulk(f.id, [b.id], 'star')).json()).toMatchObject({ changed: 1 });
    expect((await bulk(f.id, [b.id], 'unstar')).json()).toMatchObject({ changed: 1 });

    expect((await bulk(f.id, [a.id, b.id], 'archive')).json()).toMatchObject({ changed: 2 });
    expect(await view('inbox')).toEqual(['c']);
    expect(await view('archived')).toEqual(['a', 'b']);
    expect((await bulk(f.id, [a.id], 'unarchive')).json()).toMatchObject({ changed: 1 });
    expect(await view('inbox')).toEqual(['a', 'c']);

    // Trash from anywhere (inbox or archive); an archived row in the trash is not archived again; restore puts it back where it was.
    expect((await bulk(f.id, [a.id, b.id], 'trash')).json()).toMatchObject({ changed: 2 });
    expect(await view('trash')).toEqual(['a', 'b']);
    expect(await view('inbox')).toEqual(['c']);
    expect(await view('archived')).toEqual([]);
    expect((await bulk(f.id, [b.id], 'archive')).json()).toMatchObject({ changed: 0, unchanged: 1 });
    expect((await bulk(f.id, [a.id, b.id], 'restore')).json()).toMatchObject({ changed: 2 });
    expect(await view('inbox')).toEqual(['a', 'c']);
    expect(await view('archived')).toEqual(['b']);
    expect(await view('trash')).toEqual([]);
  });

  it('counts an id that is not a response of this form as missing and touches nothing of it', async () => {
    const f = await publish(userId, 'Bulk missing');
    const mine = await store({ name: short('mine') }, { form: f.id, version: f.versionId });
    const elsewhere = await store({ name: short('elsewhere') });
    const ids = [mine.id, mine.id, elsewhere.id, uuidV7(new Date()), randomUUID()];
    const res = await bulk(f.id, ids, 'trash');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ requested: 4, changed: 1, unchanged: 0, missing: 3 });
    // The response of the other form was named but is not this form's: still where it was.
    expect((await owner.query('select trashed_at from submissions where id = $1', [elsewhere.id])).rows[0].trashed_at).toBeNull();
    // A form that is not in the org is a 404, not an empty success.
    expect((await bulk(randomUUID(), [mine.id], 'trash')).statusCode).toBe(404);
  });

  it('refuses a bulk body that is not valid', async () => {
    for (const payload of [{ ids: [], action: 'trash' }, { ids: [randomUUID()], action: 'burn' }, { ids: ['x'], action: 'trash' }, { ids: Array.from({ length: 501 }, () => randomUUID()), action: 'trash' }, { action: 'trash' }]) {
      const res = await app.inject({ method: 'POST', url: `/v1/forms/${formId}/submissions/bulk`, headers: as(userId), payload });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
    }
  });

  it('records each change on the audit chain, with the ids, and 500 ids are in the records together (BL-192)', async () => {
    const f = await publish(userId, 'Bulk audit');
    const ids: string[] = [];
    // 500 rows in one statement: the grid's own limit is 200, but a bulk action takes 500.
    const base = on(1).getTime();
    for (let i = 0; i < 500; i += 1) ids.push(uuidV7(new Date(base + i * 60_000)));
    await owner.query(
      `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta)
       select u.id, uuid_v7_ts(u.id), v.org_id, v.form_id, v.id, decode(v.content_hash, 'hex'), 0, 'complete', '{}', '{}', '{}'
       from unnest($1::uuid[]) as u(id), form_versions v where v.id = $2`,
      [ids, f.versionId],
    );
    const trashed = await bulk(f.id, ids, 'trash');
    expect(trashed.json()).toMatchObject({ requested: 500, changed: 500 });
    const records = await auditOf(trashed, 'submission.trashed');
    expect(records.length).toBeGreaterThan(1);
    const metadata = records.map((r) => r.metadata as { ids: string[]; count: number; part: number; parts: number; _omitted?: string });
    expect(metadata.every((m) => m._omitted === undefined && m.count === 500 && m.parts === records.length)).toBe(true);
    expect(metadata.map((m) => m.part)).toEqual(records.map((_, i) => i + 1));
    expect(metadata.flatMap((m) => m.ids).sort()).toEqual([...ids].sort());

    const restored = await bulk(f.id, ids.slice(0, 2), 'restore');
    expect(await auditOf(restored, 'submission.restored')).toMatchObject([{ metadata: { count: 2, ids: ids.slice(0, 2) } }]);
    const read = await bulk(f.id, ids.slice(0, 2), 'mark_read');
    expect(await auditOf(read, 'submission.updated')).toMatchObject([{ metadata: { ops: ['mark_read'], count: 2 } }]);
    // An action that changed nothing is not a record.
    const none = await bulk(f.id, ids.slice(0, 2), 'mark_read');
    expect(none.json()).toMatchObject({ changed: 0, unchanged: 2 });
    expect(await auditOf(none, 'submission.updated')).toHaveLength(0);
  });
});

describe('delete forever', () => {
  const bulk = (form: string, ids: string[], action: string, user = userId) => app.inject({ method: 'POST', url: `/v1/forms/${form}/submissions/bulk`, headers: as(user), payload: { ids, action } });

  /** A response with a search document and an uploaded file (its record and its bytes), as the submit route and the upload route leave them. */
  async function withFile(f: { id: string; versionId: string }, name: string, o: { trashed: boolean }) {
    const row = await storeIndexed(f.id, f.versionId, { name: short(name) }, { trashed: o.trashed });
    const fileId = randomUUID();
    await files.put(fileId, Buffer.from(`%PDF-1.4 bytes of ${name}`));
    await owner.query(
      `insert into form_files (id, org_id, form_id, block_id, name, mime, size_bytes, sha256, purpose, submission_id, submission_received_at)
       values ($1, $2, $3, 'cv', $4, 'application/pdf', 20, $5, 'file', $6, $7)`,
      [fileId, orgId, f.id, `${name}.pdf`, 'b'.repeat(64), row.id, row.receivedAt],
    );
    return { ...row, fileId };
  }

  it('removes the rows, their search documents, their file records and the bytes, of trashed responses only', async () => {
    const f = await publish(userId, 'Purge');
    const doomed = [await withFile(f, 'first', { trashed: true }), await withFile(f, 'second', { trashed: true })];
    const kept = await withFile(f, 'kept', { trashed: true });
    const other = await publish(userId, 'Purge neighbour');
    const neighbour = await withFile(other, 'neighbour', { trashed: true });
    const ids = doomed.map((d) => d.id);

    // Before: everything is there.
    expect(await count('select count(*)::int as n from submissions where id = any($1)', [ids])).toBe(2);
    expect(await count('select count(*)::int as n from submission_search where submission_id = any($1)', [ids])).toBe(2);
    expect(await count('select count(*)::int as n from form_files where id = any($1)', [doomed.map((d) => d.fileId)])).toBe(2);
    expect(await files.get(doomed[0]!.fileId)).not.toBeNull();

    const res = await bulk(f.id, [...ids, uuidV7(new Date())], 'delete');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ action: 'delete', requested: 3, changed: 2, unchanged: 0, missing: 1, removedFiles: 2 });

    expect(await count('select count(*)::int as n from submissions where id = any($1)', [ids])).toBe(0);
    expect(await count('select count(*)::int as n from submission_search where submission_id = any($1)', [ids])).toBe(0);
    expect(await count('select count(*)::int as n from form_files where id = any($1)', [doomed.map((d) => d.fileId)])).toBe(0);
    for (const d of doomed) expect(await files.get(d.fileId)).toBeNull();
    expect((await app.inject({ url: `/v1/forms/${f.id}/submissions/${ids[0]}`, headers: as(userId) })).statusCode).toBe(404);

    // Another trashed response of the same form, and one of another form, keep everything they have.
    for (const survivor of [kept, neighbour]) {
      expect(await count('select count(*)::int as n from submissions where id = $1', [survivor.id])).toBe(1);
      expect(await count('select count(*)::int as n from submission_search where submission_id = $1', [survivor.id])).toBe(1);
      expect(await count('select count(*)::int as n from form_files where id = $1', [survivor.fileId])).toBe(1);
      expect(await files.get(survivor.fileId)).not.toBeNull();
    }
    expect(await auditOf(res, 'submission.purged')).toMatchObject([{ actorId: userId, formId: f.id, outcome: 'success', metadata: { count: 2, ids, fileCount: 2 } }]);
    // The audit record names ids and counts: no file name, no answer.
    expect(JSON.stringify(await auditOf(res, 'submission.purged'))).not.toMatch(/first|second|\.pdf/);

    // Deleting what is already gone is not an error: the ids are missing now.
    expect((await bulk(f.id, ids, 'delete')).json()).toMatchObject({ changed: 0, missing: 2, removedFiles: 0 });
  });

  it('refuses the whole call, and deletes nothing, when any response named is not in the trash', async () => {
    const f = await publish(userId, 'Purge refused');
    const trashed = await withFile(f, 'trashed', { trashed: true });
    const live = await withFile(f, 'live', { trashed: false });
    const res = await bulk(f.id, [trashed.id, live.id], 'delete');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'SUBMISSION_NOT_TRASHED' });
    for (const row of [trashed, live]) {
      expect(await count('select count(*)::int as n from submissions where id = $1', [row.id])).toBe(1);
      expect(await count('select count(*)::int as n from submission_search where submission_id = $1', [row.id])).toBe(1);
      expect(await count('select count(*)::int as n from form_files where id = $1', [row.fileId])).toBe(1);
      expect(await files.get(row.fileId)).not.toBeNull();
    }
    expect(await auditOf(res, 'submission.purged')).toHaveLength(0);
  });

  it('refuses a response under a legal hold or inside its statutory retention period', async () => {
    const f = await publish(userId, 'Purge held');
    const held = await withFile(f, 'held', { trashed: true });
    const retained = await withFile(f, 'retained', { trashed: true });
    await owner.query('update submissions set legal_hold = true where id = $1', [held.id]);
    await owner.query("update submissions set statutory_hold_until = now() + interval '30 days' where id = $1", [retained.id]);
    for (const row of [held, retained]) {
      const res = await bulk(f.id, [row.id], 'delete');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'SUBMISSION_HELD' });
      expect(await count('select count(*)::int as n from submissions where id = $1', [row.id])).toBe(1);
      expect(await files.get(row.fileId)).not.toBeNull();
    }
    // The statutory period over, the response can go.
    await owner.query("update submissions set statutory_hold_until = now() - interval '1 day' where id = $1", [retained.id]);
    expect((await bulk(f.id, [retained.id], 'delete')).json()).toMatchObject({ changed: 1 });
  });

  it('keeps the bytes when the delete is rolled back, and the rows when only the bytes are missing', async () => {
    const f = await publish(userId, 'Purge bytes');
    const row = await withFile(f, 'gone-already', { trashed: true });
    // The bytes were removed some other way (an operator, a sweep): the response still deletes.
    await files.remove(row.fileId);
    const res = await bulk(f.id, [row.id], 'delete');
    expect(res.json()).toMatchObject({ changed: 1, removedFiles: 1 });
    expect(await count('select count(*)::int as n from form_files where id = $1', [row.fileId])).toBe(0);
  });
});

describe('who may read and change the submissions of a form', () => {
  let submissionId: string;

  beforeAll(async () => {
    submissionId = (await store({ name: short('secret') })).id;
  });

  it('lets a creator register the form but not read submissions', async () => {
    const id = randomUUID();
    expect((await app.inject({ method: 'POST', url: '/v1/forms', headers: as(creatorId), payload: { id, title: 'Draft' } })).statusCode).toBe(200);
    expect((await app.inject({ url: `/v1/forms/${id}/submissions`, headers: as(creatorId) })).statusCode).toBe(403);
  });

  it('refuses a caller with no session, on every route', async () => {
    const urls: Array<[string, string, unknown?]> = [
      ['GET', `/v1/forms/${formId}/submissions`],
      ['GET', `/v1/forms/${formId}/submissions/${submissionId}`],
      ['PATCH', `/v1/forms/${formId}/submissions/${submissionId}`, { read: true }],
      ['POST', `/v1/forms/${formId}/submissions/bulk`, { ids: [submissionId], action: 'trash' }],
    ];
    for (const [method, url, payload] of urls) {
      const res = await app.inject({ method: method as 'GET', url, headers: BROWSER, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.body).not.toContain('secret');
    }
  });

  it('has no public read route any more', async () => {
    for (const url of [`/v1/p/by-form/${formId}/submissions`, `/v1/p/by-form/${formId}/submissions/${submissionId}`]) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('secret');
    }
  });

  it('refuses a member of another org who names that org, and shows one who names their own nothing of the form', async () => {
    const named = await app.inject({ url: `/v1/forms/${formId}/submissions`, headers: { 'x-fr-dev-user': outsiderId, 'x-fr-org': orgId } });
    expect(named.statusCode).toBe(403);
    expect(named.body).not.toContain('secret');
    const own = { 'x-fr-dev-user': outsiderId, 'x-fr-org': outsiderOrgId };
    for (const url of [`/v1/forms/${formId}/submissions`, `/v1/forms/${formId}/submissions/${submissionId}`]) {
      const res = await app.inject({ url, headers: own });
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain('secret');
    }
  });

  it('lets a viewer read the grid and one response, but answers 403 to a change, and audits the refusal', async () => {
    const list = await app.inject({ url: `/v1/forms/${formId}/submissions`, headers: as(viewerId) });
    expect(list.statusCode).toBe(200);
    const one = await app.inject({ url: `/v1/forms/${formId}/submissions/${submissionId}`, headers: as(viewerId) });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ id: submissionId, fields: [{ id: 'name', value: 'secret' }] });

    const patch = await app.inject({ method: 'PATCH', url: `/v1/forms/${formId}/submissions/${submissionId}`, headers: as(viewerId), payload: { read: true } });
    expect(patch.statusCode).toBe(403);
    expect(patch.json()).toMatchObject({ code: 'FORBIDDEN' });
    for (const action of ['trash', 'mark_read', 'star', 'archive', 'delete']) {
      const res = await app.inject({ method: 'POST', url: `/v1/forms/${formId}/submissions/bulk`, headers: as(viewerId), payload: { ids: [submissionId], action } });
      expect(res.statusCode, action).toBe(403);
    }
    const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'requestId' = $2`, [orgId, String(patch.headers['x-request-id'])]);
    expect(rows.map((r) => r.event)).toMatchObject([{ action: 'request.authorize', outcome: 'denied', actorId: viewerId, reason: 'missing_permission:submissions.edit' }]);
    // Nothing changed.
    expect((await owner.query('select read, trashed_at from submissions where id = $1', [submissionId])).rows[0]).toMatchObject({ read: false, trashed_at: null });
  });
});
