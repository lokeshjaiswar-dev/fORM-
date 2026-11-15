import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { provision } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

/*
 * WP-1.06 forms list and form actions: search, sort, favourites, lifecycle and cursor paging; clone, archive, trash and
 * restore with their audit records. The expected order of every list comes from the database itself (an ORDER BY the
 * test writes out), never from JavaScript's idea of how text sorts, so the check holds under any collation.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let app: FastifyInstance;
let owner: pg.Pool;
let orgA: string;
let orgB: string;
let u1: string; // owner of org A
let u2: string; // editor of org A
let u3: string; // viewer of org A
let b1: string; // owner of org B
let bForm: string;
const forms: Record<string, string> = {};

const as = (user: string, org: string) => ({ 'x-fr-dev-user': user, 'x-fr-org': org });
const asWrite = (user: string, org: string) => ({ ...as(user, org), ...BROWSER });

interface Item {
  id: string;
  title: string;
  lifecycle: string;
  favourite: boolean;
  submissionCount: number;
  isLive: boolean;
  createdAt: string;
  updatedAt: string;
}
interface ListBody {
  items: Item[];
  nextCursor: string | null;
}

async function user(org: string, role: string, tag: string): Promise<string> {
  const id = randomUUID();
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [id, `${tag}@list.test`]);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [org, id, role]);
  return id;
}

/** Timestamps are the base time minus whole minutes, plus microseconds: JavaScript dates cannot tell two microseconds apart. */
const BASE = '2026-11-01T10:00:00Z';

interface Seed {
  key: string;
  title: string;
  /** Minutes before BASE that the form was created / last updated. */
  c: number;
  u: number;
  /** Microseconds added to updated_at. */
  micro?: number;
  s?: number;
  lifecycle?: 'active' | 'archived' | 'trashed';
}

async function seedForm(org: string, by: string, f: Seed): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `insert into forms (id, org_id, team_id, owner_user_id, title, lifecycle, trashed_at, submission_count, created_at, updated_at)
     values ($1, $2, $2, $3, $4, $5::text, case when $5::text = 'trashed' then now() end, $6, $7::timestamptz - make_interval(mins => $8), $7::timestamptz - make_interval(mins => $9) + $10::int * interval '1 microsecond')`,
    [id, org, by, f.title, f.lifecycle ?? 'active', f.s ?? 0, BASE, f.c, f.u, f.micro ?? 0],
  );
  forms[f.key] = id;
  return id;
}

/** Makes a form live: a published version row and the form's address, the way publishing leaves it. */
async function goLive(org: string, formId: string, by: string, slug: string): Promise<void> {
  const versionId = randomUUID();
  await owner.query(
    `insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash) values ($1, $2, $3, 1, 2, $4, '{}', '{}', 'test')`,
    [versionId, org, formId, by],
  );
  await owner.query('update forms set live_version_id = $2, slug = $3 where id = $1', [formId, versionId, slug]);
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_forms_list');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  orgA = randomUUID();
  orgB = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2), ($3, $4, $4)', [orgA, 'list-a', orgB, 'list-b']);
  u1 = await user(orgA, 'owner', 'owner');
  u2 = await user(orgA, 'editor', 'editor');
  u3 = await user(orgA, 'viewer', 'viewer');
  b1 = await user(orgB, 'owner', 'owner-b');

  const seeds: Seed[] = [
    { key: 'f0', title: 'Alpha survey', c: 100, u: 10, s: 5 },
    { key: 'f1', title: 'beta feedback', c: 90, u: 20 },
    { key: 'f2', title: 'Gamma intake', c: 80, u: 30, s: 12 },
    // One microsecond after f2, and a third form at exactly f2's instant: only a cursor that keeps the microseconds, and
    // breaks the tie by id, shows all three once.
    { key: 'f3', title: 'Delta signup', c: 70, u: 30, micro: 1, s: 12 },
    { key: 'f13', title: 'Alpha survey', c: 1, u: 30, s: 5 },
    { key: 'f4', title: 'epsilon form', c: 60, u: 40, s: 3 },
    { key: 'f5', title: '100% complete', c: 50, u: 50, s: 7 },
    { key: 'f6', title: 'under_score test', c: 40, u: 60, s: 7 },
    { key: 'f7', title: 'Zeta quiz', c: 30, u: 70 },
    { key: 'f8', title: 'Eta registration', c: 20, u: 80, s: 100 },
    { key: 'f9', title: 'Theta contact', c: 10, u: 90, s: 1 },
    { key: 'f10', title: 'Alpha survey 2', c: 5, u: 95, s: 2 },
    { key: 'f11', title: 'Old archived one', c: 3, u: 3, lifecycle: 'archived' },
    { key: 'f12', title: 'Old trashed one', c: 2, u: 2, lifecycle: 'trashed' },
  ];
  for (const f of seeds) await seedForm(orgA, u1, f);
  bForm = await seedForm(orgB, b1, { key: 'b0', title: 'Alpha survey (org B)', c: 1, u: 1 });
  await goLive(orgA, forms.f8!, u1, 'eta-registration-live');

  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  app = await buildApp(parsed.config, { underPressure: false });
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
});

type Query = Record<string, string | number>;

function list(who: string, org: string, query: Query = {}) {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))).toString();
  return app.inject({ url: `/v1/forms${qs ? `?${qs}` : ''}`, headers: as(who, org) });
}

/** Every page of a query, following `nextCursor` until it is null. */
async function walk(who: string, org: string, query: Query): Promise<Item[][]> {
  const pages: Item[][] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const res = await list(who, org, { ...query, ...(cursor ? { cursor } : {}) });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<ListBody>();
    pages.push(body.items);
    if (!body.nextCursor) return pages;
    cursor = body.nextCursor;
  }
  throw new Error('the cursor never ended');
}

const SORT_SQL = { updated: 'updated_at', created: 'created_at', title: 'lower(title)', submissions: 'submission_count' } as const;
const DEFAULT_DIR = { updated: 'desc', created: 'desc', title: 'asc', submissions: 'desc' } as const;

/** The ids the database orders by the sort, then id: what a complete walk must return. */
async function expectedIds(org: string, sort: keyof typeof SORT_SQL, dir: 'asc' | 'desc', where = `lifecycle = 'active'`, params: unknown[] = []): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(`select id from forms where org_id = $1 and ${where} order by ${SORT_SQL[sort]} ${dir}, id ${dir}`, [org, ...params]);
  return rows.map((r) => r.id);
}

const idsOf = (pages: Item[][]) => pages.flat().map((i) => i.id);

describe('GET /v1/forms: rows', () => {
  it('carries favourite, submissionCount and isLive on every row', async () => {
    const res = await list(u1, orgA, { limit: 200 });
    expect(res.statusCode).toBe(200);
    const items = res.json<ListBody>().items;
    expect(items.every((i) => typeof i.favourite === 'boolean' && Number.isInteger(i.submissionCount) && typeof i.isLive === 'boolean')).toBe(true);
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(forms.f8!)).toMatchObject({ title: 'Eta registration', submissionCount: 100, isLive: true, favourite: false, lifecycle: 'active' });
    expect(byId.get(forms.f0!)).toMatchObject({ submissionCount: 5, isLive: false });
    expect(items.filter((i) => i.isLive).map((i) => i.id)).toEqual([forms.f8]);
  });

  it('is not live once the form is not active, whatever version it has', async () => {
    const id = await seedForm(orgA, u1, { key: 'liveArchived', title: 'Live then archived', c: 4, u: 4, lifecycle: 'archived' });
    await goLive(orgA, id, u1, 'live-then-archived');
    const archived = await list(u1, orgA, { lifecycle: 'archived', q: 'live then' });
    expect(archived.json<ListBody>().items).toEqual([expect.objectContaining({ id, lifecycle: 'archived', isLive: false })]);
  });

  it('returns one form by id, and a 404 for another org’s', async () => {
    const res = await app.inject({ url: `/v1/forms/${forms.f8}`, headers: as(u3, orgA) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: forms.f8, title: 'Eta registration', isLive: true, submissionCount: 100 });
    expect((await app.inject({ url: `/v1/forms/${forms.f8}`, headers: as(b1, orgB) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/v1/forms/${randomUUID()}`, headers: as(u1, orgA) })).statusCode).toBe(404);
  });
});

describe('GET /v1/forms: sort and cursor', () => {
  for (const sort of ['updated', 'created', 'title', 'submissions'] as const) {
    for (const flipped of [false, true]) {
      const dir = flipped ? (DEFAULT_DIR[sort] === 'asc' ? 'desc' : 'asc') : DEFAULT_DIR[sort];
      it(`pages by ${sort} ${dir}${flipped ? '' : ' (the default)'}: every row once, in the database's order, whatever the page size`, async () => {
        const want = await expectedIds(orgA, sort, dir);
        expect(want.length).toBeGreaterThanOrEqual(12);
        for (const limit of [3, 5, 1]) {
          const pages = await walk(u1, orgA, { sort, limit, ...(flipped ? { dir } : {}) });
          expect(idsOf(pages), `limit ${limit}`).toEqual(want);
          // The last page has no cursor even when it is exactly full, and every other page is full.
          expect(pages.slice(0, -1).every((p) => p.length === limit)).toBe(true);
          expect(pages.at(-1)!.length).toBeGreaterThan(0);
        }
      });
    }
  }

  it('sorts by updated, newest first, when no sort is named, and keeps microsecond differences apart', async () => {
    const res = await list(u1, orgA, { limit: 200 });
    const ids = res.json<ListBody>().items.map((i) => i.id);
    expect(ids).toEqual(await expectedIds(orgA, 'updated', 'desc'));
    // f3 is one microsecond newer than f2 and f13, which tie: all three come in this order, each once.
    const [i2, i3, i13] = [forms.f2!, forms.f3!, forms.f13!].map((id) => ids.indexOf(id));
    expect(i3).toBeLessThan(Math.min(i2!, i13!));
    const walked = idsOf(await walk(u1, orgA, { limit: 2 }));
    expect(walked.filter((id) => [forms.f2, forms.f3, forms.f13].includes(id))).toHaveLength(3);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('ends a list whose size is a multiple of the page size with a null cursor on the full last page', async () => {
    const total = (await expectedIds(orgA, 'updated', 'desc')).length;
    const res = await list(u1, orgA, { limit: total });
    expect(res.json<ListBody>().items).toHaveLength(total);
    expect(res.json<ListBody>().nextCursor).toBeNull();
    const short = await list(u1, orgA, { limit: total - 1 });
    expect(short.json<ListBody>().nextCursor).toEqual(expect.any(String));
  });

  it('refuses a cursor that is not this query’s: edited, other sort or filter, other member, other org, or junk (400)', async () => {
    const first = await list(u1, orgA, { limit: 2, sort: 'title' });
    const cursor = first.json<ListBody>().nextCursor!;
    expect(cursor).toMatch(/^c1\./);

    const bad = async (who: string, org: string, query: Query, why: string) => {
      const res = await list(who, org, query);
      expect(res.statusCode, why).toBe(400);
      expect(res.json(), why).toMatchObject({ code: 'INVALID_CURSOR' });
    };
    const [prefix, payload, signature] = cursor.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify(['aaa', forms.f0]), 'utf8').toString('base64url');
    await bad(u1, orgA, { sort: 'title', cursor: `${prefix}.${forged}.${signature}` }, 'edited position');
    await bad(u1, orgA, { sort: 'title', cursor: `${prefix}.${payload}.${signature.slice(0, -3)}AAA` }, 'edited signature');
    await bad(u1, orgA, { sort: 'updated', cursor }, 'another sort');
    await bad(u1, orgA, { sort: 'title', dir: 'desc', cursor }, 'another direction');
    await bad(u1, orgA, { sort: 'title', q: 'alpha', cursor }, 'another search');
    await bad(u1, orgA, { sort: 'title', lifecycle: 'archived', cursor }, 'another lifecycle');
    await bad(u1, orgA, { sort: 'title', favourite: 'true', cursor }, 'another filter');
    await bad(u2, orgA, { sort: 'title', cursor }, 'another member (stars are personal)');
    await bad(b1, orgB, { sort: 'title', cursor }, 'another org');
    await bad(u1, orgA, { sort: 'title', cursor: 'abc' }, 'junk');
    // The cursor itself still works for the query it was made for.
    expect((await list(u1, orgA, { sort: 'title', cursor })).statusCode).toBe(200);
  });

  it('refuses a limit, sort or filter outside what it allows (400)', async () => {
    for (const query of [{ limit: 0 }, { limit: 201 }, { sort: 'owner' }, { dir: 'sideways' }, { lifecycle: 'deleted' }, { favourite: 'false' }, { q: 'x'.repeat(101) }]) {
      const res = await list(u1, orgA, query);
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
    }
    expect((await list(u1, orgA, { limit: 200 })).statusCode).toBe(200);
  });
});

describe('GET /v1/forms: search and lifecycle', () => {
  it('finds titles by any part of the words, in any case', async () => {
    const want = [forms.f0, forms.f10, forms.f13].sort();
    for (const q of ['alpha', 'ALPHA', 'lpha surv', '  alpha survey  ']) {
      const res = await list(u1, orgA, { q, limit: 200 });
      expect(res.json<ListBody>().items.map((i) => i.id).sort(), q).toEqual(want);
    }
    expect((await list(u1, orgA, { q: 'no such title anywhere' })).json<ListBody>().items).toEqual([]);
  });

  it('treats %, _ and \\ in the search as the characters they are, not as wildcards', async () => {
    expect((await list(u1, orgA, { q: '%' })).json<ListBody>().items.map((i) => i.id)).toEqual([forms.f5]);
    expect((await list(u1, orgA, { q: '_' })).json<ListBody>().items.map((i) => i.id)).toEqual([forms.f6]);
    expect((await list(u1, orgA, { q: '100%' })).json<ListBody>().items.map((i) => i.id)).toEqual([forms.f5]);
    const backslash = await list(u1, orgA, { q: '\\' });
    expect(backslash.statusCode).toBe(200);
    expect(backslash.json<ListBody>().items).toEqual([]);
  });

  it('never returns another org’s forms, for any search', async () => {
    const mine = (await list(u1, orgA, { q: 'org B', limit: 200 })).json<ListBody>().items;
    expect(mine).toEqual([]);
    const theirs = (await list(b1, orgB, { q: 'alpha', limit: 200 })).json<ListBody>().items;
    expect(theirs.map((i) => i.id)).toEqual([bForm]);
  });

  it('pages a search, with its sort, by cursor', async () => {
    const pages = await walk(u1, orgA, { q: 'alpha', sort: 'title', limit: 2 });
    expect(pages.map((p) => p.length)).toEqual([2, 1]);
    expect(idsOf(pages)).toEqual(await expectedIds(orgA, 'title', 'asc', `lifecycle = 'active' and title ilike '%alpha%'`));
  });

  it('lists by lifecycle: active by default, archived and trashed on request', async () => {
    const active = idsOf(await walk(u1, orgA, { limit: 200 }));
    expect(active).not.toContain(forms.f11);
    expect(active).not.toContain(forms.f12);
    expect(active).toEqual(await expectedIds(orgA, 'updated', 'desc'));
    const archived = (await list(u1, orgA, { lifecycle: 'archived', q: 'old' })).json<ListBody>().items;
    expect(archived).toEqual([expect.objectContaining({ id: forms.f11, lifecycle: 'archived' })]);
    const trashed = (await list(u1, orgA, { lifecycle: 'trashed', q: 'old' })).json<ListBody>().items;
    expect(trashed).toEqual([expect.objectContaining({ id: forms.f12, lifecycle: 'trashed' })]);
  });
});

describe('favourites', () => {
  const star = (who: string, org: string, id: string, method: 'PUT' | 'DELETE' = 'PUT') => app.inject({ method, url: `/v1/forms/${id}/favourite`, headers: asWrite(who, org) });

  it('are per member: one member’s stars are not another’s, in the flag or in the filter', async () => {
    for (const key of ['f0', 'f5', 'f9']) expect((await star(u1, orgA, forms[key]!)).json()).toEqual({ favourite: true });
    for (const key of ['f5', 'f7']) expect((await star(u2, orgA, forms[key]!)).statusCode).toBe(200);

    const idsFor = async (who: string) => (await list(who, orgA, { favourite: 'true', limit: 200 })).json<ListBody>().items.map((i) => i.id);
    expect((await idsFor(u1)).sort()).toEqual([forms.f0, forms.f5, forms.f9].sort());
    expect((await idsFor(u2)).sort()).toEqual([forms.f5, forms.f7].sort());
    expect(await idsFor(u3)).toEqual([]);

    const flags = async (who: string) => new Map((await list(who, orgA, { limit: 200 })).json<ListBody>().items.map((i) => [i.id, i.favourite]));
    const f1 = await flags(u1);
    const f2 = await flags(u2);
    expect([f1.get(forms.f0!), f1.get(forms.f7!), f1.get(forms.f5!)]).toEqual([true, false, true]);
    expect([f2.get(forms.f0!), f2.get(forms.f7!), f2.get(forms.f5!)]).toEqual([false, true, true]);
    expect([...f1].filter(([, v]) => v)).toHaveLength(3);
  });

  it('page by cursor with the filter and a sort, and the flag is true on every row', async () => {
    const pages = await walk(u1, orgA, { favourite: 'true', sort: 'title', limit: 2 });
    expect(pages.map((p) => p.length)).toEqual([2, 1]);
    expect(pages.flat().every((i) => i.favourite)).toBe(true);
    expect(idsOf(pages)).toEqual(
      await expectedIds(orgA, 'title', 'asc', `lifecycle = 'active' and id in (select form_id from form_favourites where user_id = $2)`, [u1]),
    );
  });

  it('can be removed, and removing one member’s star leaves the other’s', async () => {
    expect((await star(u1, orgA, forms.f5!, 'DELETE')).json()).toEqual({ favourite: false });
    const { rows } = await owner.query<{ user_id: string }>('select user_id from form_favourites where form_id = $1', [forms.f5]);
    expect(rows.map((r) => r.user_id)).toEqual([u2]);
    expect((await list(u1, orgA, { favourite: 'true', limit: 200 })).json<ListBody>().items.map((i) => i.id)).not.toContain(forms.f5);
  });

  it('can be repeated without a second row or an error', async () => {
    expect((await star(u3, orgA, forms.f1!)).statusCode).toBe(200);
    expect((await star(u3, orgA, forms.f1!)).statusCode).toBe(200);
    expect((await owner.query('select 1 from form_favourites where form_id = $1 and user_id = $2', [forms.f1, u3])).rows).toHaveLength(1);
    expect((await star(u3, orgA, forms.f1!, 'DELETE')).statusCode).toBe(200);
    expect((await star(u3, orgA, forms.f1!, 'DELETE')).statusCode).toBe(200);
    expect((await owner.query('select 1 from form_favourites where form_id = $1 and user_id = $2', [forms.f1, u3])).rows).toHaveLength(0);
  });

  it('are refused, as a 404 and without a row, for a form that does not exist or is another org’s', async () => {
    expect((await star(u1, orgA, randomUUID())).statusCode).toBe(404);
    expect((await star(b1, orgB, forms.f0!)).statusCode).toBe(404);
    expect((await star(b1, orgB, forms.f0!, 'DELETE')).statusCode).toBe(404);
    expect((await owner.query('select 1 from form_favourites where user_id = $1', [b1])).rows).toHaveLength(0);
    // The star of org A’s member is untouched by org B's DELETE.
    expect((await owner.query('select 1 from form_favourites where form_id = $1 and user_id = $2', [forms.f0, u1])).rows).toHaveLength(1);
  });
});

describe('clone', () => {
  async function formWithDraft(title: string): Promise<string> {
    const created = await app.inject({ method: 'POST', url: '/v1/forms', headers: asWrite(u1, orgA), payload: { title } });
    const { id } = created.json<{ id: string }>();
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/forms/${id}/draft`,
      headers: { ...asWrite(u1, orgA), 'if-match': '0' },
      payload: { draft: draftWith(id, [fieldBlock('name', 'short_text'), fieldBlock('mail', 'email')], title) },
    });
    expect(put.statusCode, put.body).toBe(200);
    return id;
  }

  it('makes a new form under a new UUIDv7 id, titled "Copy of …", with the same definition under that id', async () => {
    const source = await formWithDraft('Clone source');
    await goLive(orgA, source, u1, 'clone-source-live');
    await owner.query(`update forms set submission_count = 9 where id = $1`, [source]);
    await owner.query('insert into form_access (form_id, org_id, enabled, password_hash) values ($1, $2, false, $3)', [source, orgA, '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$aGFzaA']);
    const before = (await owner.query('select draft, draft_rev from form_drafts where form_id = $1', [source])).rows[0];

    const res = await app.inject({ method: 'POST', url: `/v1/forms/${source}/clone`, headers: asWrite(u2, orgA) });
    expect(res.statusCode, res.body).toBe(201);
    const copy = res.json<Item>();
    expect(copy.id).toMatch(UUID_V7);
    expect(copy.id).not.toBe(source);
    expect(copy).toMatchObject({ title: 'Copy of Clone source', lifecycle: 'active', isLive: false, submissionCount: 0, favourite: false });

    const { rows } = await owner.query<{ draft: { formId: string; title: string; blocks: unknown; pages: unknown }; draft_rev: number; owner_user_id: string; slug: string | null; live: string | null }>(
      `select d.draft, d.draft_rev, f.owner_user_id, f.slug, f.live_version_id as live from form_drafts d join forms f on f.id = d.form_id where d.form_id = $1`,
      [copy.id],
    );
    const original = before as { draft: { blocks: unknown; pages: unknown }; draft_rev: number };
    expect(rows[0]).toMatchObject({ draft_rev: 1, owner_user_id: u2, slug: null, live: null, draft: { formId: copy.id, title: 'Copy of Clone source' } });
    expect(rows[0]!.draft.blocks).toEqual(original.draft.blocks);
    expect(rows[0]!.draft.pages).toEqual(original.draft.pages);
    // Nothing of the source's operations came across: no access row (so its closed state and password hash stay behind), no versions.
    expect((await owner.query('select 1 from form_access where form_id = $1', [copy.id])).rows).toHaveLength(0);
    expect((await owner.query('select 1 from form_versions where form_id = $1', [copy.id])).rows).toHaveLength(0);
    // The source is unchanged.
    const after = (await owner.query('select draft, draft_rev from form_drafts where form_id = $1', [source])).rows[0];
    expect(after).toEqual(before);
    expect((await owner.query('select title, submission_count::int as n from forms where id = $1', [source])).rows[0]).toEqual({ title: 'Clone source', n: 9 });
  });

  it('can be copied again (a copy of a copy) and the copy opens as an editable draft', async () => {
    const source = await formWithDraft('Twice');
    const first = (await app.inject({ method: 'POST', url: `/v1/forms/${source}/clone`, headers: asWrite(u1, orgA) })).json<Item>();
    const second = (await app.inject({ method: 'POST', url: `/v1/forms/${first.id}/clone`, headers: asWrite(u1, orgA) })).json<Item>();
    expect(second.title).toBe('Copy of Copy of Twice');
    const got = await app.inject({ url: `/v1/forms/${second.id}/draft`, headers: as(u1, orgA) });
    expect(got.json()).toMatchObject({ draftRev: 1, draft: { formId: second.id } });
    const edit = await app.inject({
      method: 'PUT',
      url: `/v1/forms/${second.id}/draft`,
      headers: { ...asWrite(u1, orgA), 'if-match': '1' },
      payload: { draft: { ...got.json<{ draft: object }>().draft, title: 'Edited copy' } },
    });
    expect(edit.statusCode, edit.body).toBe(200);
  });

  it('gives clones that share a title and a minute different public addresses once published', async () => {
    // A UUIDv7 starts with a timestamp, so ids made together share their first characters; the address must not be built from them.
    const source = await formWithDraft('Same title');
    const copies = [
      (await app.inject({ method: 'POST', url: `/v1/forms/${source}/clone`, headers: asWrite(u1, orgA) })).json<Item>(),
      (await app.inject({ method: 'POST', url: `/v1/forms/${source}/clone`, headers: asWrite(u1, orgA) })).json<Item>(),
    ];
    const slugs: string[] = [];
    for (const copy of copies) {
      const live = await app.inject({ method: 'POST', url: `/v1/forms/${copy.id}/publish`, headers: asWrite(u1, orgA), payload: {} });
      expect(live.statusCode, live.body).toBe(200);
      slugs.push(live.json<{ slug: string }>().slug);
    }
    expect(new Set(slugs).size).toBe(2);
  });

  it('copes with a form that has no draft yet, and keeps a very long title within the limit', async () => {
    const long = await seedForm(orgA, u1, { key: 'long', title: 'L'.repeat(500), c: 1, u: 1 });
    const longCopy = (await app.inject({ method: 'POST', url: `/v1/forms/${long}/clone`, headers: asWrite(u1, orgA) })).json<Item>();
    expect(longCopy.title).toHaveLength(500);
    expect(longCopy.title.startsWith('Copy of L')).toBe(true);
    expect((await owner.query('select 1 from form_drafts where form_id = $1', [longCopy.id])).rows).toHaveLength(0);
  });

  it('writes a form.cloned audit record for the new form, naming the source', async () => {
    const source = await formWithDraft('Audited clone');
    const res = await app.inject({ method: 'POST', url: `/v1/forms/${source}/clone`, headers: asWrite(u1, orgA) });
    const copy = res.json<Item>();
    const { rows } = await owner.query<{ event: Record<string, unknown> }>(
      `select event from audit_pending where org_key = $1 and event->>'action' = 'form.cloned' and event->>'resourceId' = $2`,
      [orgA, copy.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toMatchObject({ outcome: 'success', actorId: u1, formId: copy.id, resourceType: 'form', requestId: res.headers['x-request-id'], metadata: { sourceFormId: source, hadDraft: true } });
  });

  it('is refused for a form that is not found or another org’s, and for a member without forms.create', async () => {
    const source = await formWithDraft('No clone');
    const before = (await owner.query<{ n: string }>('select count(*) as n from forms')).rows[0]!.n;
    expect((await app.inject({ method: 'POST', url: `/v1/forms/${randomUUID()}/clone`, headers: asWrite(u1, orgA) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/forms/${source}/clone`, headers: asWrite(b1, orgB) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/forms/${source}/clone`, headers: asWrite(u3, orgA) })).statusCode).toBe(403);
    expect((await owner.query<{ n: string }>('select count(*) as n from forms')).rows[0]!.n).toBe(before);
  });
});

describe('archive, trash and restore', () => {
  const act = (who: string, org: string, id: string, verb: 'archive' | 'trash' | 'restore') =>
    app.inject({ method: 'POST', url: `/v1/forms/${id}/${verb}`, headers: asWrite(who, org) });

  const auditRows = async (id: string, action: string) =>
    (
      await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'action' = $2 and event->>'resourceId' = $3 order by id`, [orgA, action, id])
    ).rows.map((r) => r.event);

  const state = async (id: string) =>
    (await owner.query<{ lifecycle: string; trashed: boolean; updated_by: string }>(`select lifecycle, trashed_at is not null as trashed, updated_by from forms where id = $1`, [id])).rows[0]!;

  it('moves a form between the lists, with an audit record for each change', async () => {
    const id = await seedForm(orgA, u1, { key: 'life', title: 'Lifecycle subject', c: 7, u: 7 });
    await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...asWrite(u1, orgA), 'if-match': '0' }, payload: { draft: draftWith(id, [], 'Lifecycle subject') } });
    await goLive(orgA, id, u1, 'lifecycle-subject');
    const resolves = async () => (await owner.query('select * from resolve_form_slug($1)', ['lifecycle-subject'])).rows.length;
    expect(await resolves()).toBe(1);

    const archived = await act(u2, orgA, id, 'archive');
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json()).toMatchObject({ id, lifecycle: 'archived', isLive: false });
    expect(await state(id)).toEqual({ lifecycle: 'archived', trashed: false, updated_by: u2 });
    expect(await resolves()).toBe(0);
    expect((await list(u1, orgA, { lifecycle: 'archived', q: 'lifecycle subject' })).json<ListBody>().items.map((i) => i.id)).toEqual([id]);
    expect((await list(u1, orgA, { q: 'lifecycle subject' })).json<ListBody>().items).toEqual([]);
    expect(await auditRows(id, 'form.archived')).toEqual([
      expect.objectContaining({ outcome: 'success', actorId: u2, formId: id, requestId: archived.headers['x-request-id'], metadata: { from: 'active', to: 'archived' } }),
    ]);

    const trashed = await act(u1, orgA, id, 'trash');
    expect(trashed.json()).toMatchObject({ lifecycle: 'trashed' });
    expect(await state(id)).toMatchObject({ lifecycle: 'trashed', trashed: true });
    expect(await auditRows(id, 'form.trashed')).toEqual([expect.objectContaining({ actorId: u1, metadata: { from: 'archived', to: 'trashed' } })]);

    const restored = await act(u1, orgA, id, 'restore');
    expect(restored.json()).toMatchObject({ lifecycle: 'active', isLive: true });
    expect(await state(id)).toMatchObject({ lifecycle: 'active', trashed: false });
    expect(await resolves()).toBe(1);
    expect(await auditRows(id, 'form.restored')).toEqual([expect.objectContaining({ metadata: { from: 'trashed', to: 'active' } })]);

    // Nothing was deleted on the way: the draft is intact and the versions are there.
    expect((await owner.query<{ draft_rev: number }>('select draft_rev from form_drafts where form_id = $1', [id])).rows[0]!.draft_rev).toBe(1);
    expect((await owner.query('select 1 from form_versions where form_id = $1', [id])).rows).toHaveLength(1);
  });

  it('trashes an active form directly, and restores an archived one', async () => {
    const id = await seedForm(orgA, u1, { key: 'life2', title: 'Straight to trash', c: 7, u: 7 });
    expect((await act(u1, orgA, id, 'trash')).json()).toMatchObject({ lifecycle: 'trashed' });
    expect(await auditRows(id, 'form.trashed')).toEqual([expect.objectContaining({ metadata: { from: 'active', to: 'trashed' } })]);
    expect((await act(u1, orgA, id, 'restore')).json()).toMatchObject({ lifecycle: 'active' });
    expect((await act(u1, orgA, id, 'archive')).json()).toMatchObject({ lifecycle: 'archived' });
    expect((await act(u1, orgA, id, 'restore')).json()).toMatchObject({ lifecycle: 'active' });
    expect(await auditRows(id, 'form.restored')).toEqual([
      expect.objectContaining({ metadata: { from: 'trashed', to: 'active' } }),
      expect.objectContaining({ metadata: { from: 'archived', to: 'active' } }),
    ]);
  });

  it('answers a repeat of the same verb with the form as it is, and writes no second audit record', async () => {
    const id = await seedForm(orgA, u1, { key: 'life3', title: 'Repeated verbs', c: 7, u: 7 });
    for (let i = 0; i < 3; i++) expect((await act(u1, orgA, id, 'archive')).json()).toMatchObject({ lifecycle: 'archived' });
    expect(await auditRows(id, 'form.archived')).toHaveLength(1);
    for (let i = 0; i < 2; i++) expect((await act(u1, orgA, id, 'trash')).json()).toMatchObject({ lifecycle: 'trashed' });
    expect(await auditRows(id, 'form.trashed')).toHaveLength(1);
    for (let i = 0; i < 2; i++) expect((await act(u1, orgA, id, 'restore')).json()).toMatchObject({ lifecycle: 'active' });
    expect(await auditRows(id, 'form.restored')).toHaveLength(1);
  });

  it('refuses a move the form’s state does not allow (409) and changes nothing', async () => {
    const id = await seedForm(orgA, u1, { key: 'life4', title: 'In the bin', c: 7, u: 7, lifecycle: 'trashed' });
    const res = await act(u1, orgA, id, 'archive');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'FORM_STATE_CONFLICT' });
    expect(await state(id)).toMatchObject({ lifecycle: 'trashed', trashed: true });
    expect(await auditRows(id, 'form.archived')).toHaveLength(0);
  });

  it('has one winner when the same form is moved twice at once, and one audit record', async () => {
    const id = await seedForm(orgA, u1, { key: 'life5', title: 'Raced', c: 7, u: 7 });
    const results = await Promise.all([act(u1, orgA, id, 'archive'), act(u2, orgA, id, 'archive'), act(u1, orgA, id, 'archive')]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(await auditRows(id, 'form.archived')).toHaveLength(1);
    expect((await state(id)).lifecycle).toBe('archived');
  });

  it('answers 404 for a form that is not there or is another org’s, and 403 (audited) for a viewer', async () => {
    const id = await seedForm(orgA, u1, { key: 'life6', title: 'Not for viewers', c: 7, u: 7 });
    for (const verb of ['archive', 'trash', 'restore'] as const) {
      expect((await act(u1, orgA, randomUUID(), verb)).statusCode, verb).toBe(404);
      expect((await act(b1, orgB, id, verb)).statusCode, verb).toBe(404);
      const denied = await act(u3, orgA, id, verb);
      expect(denied.statusCode, verb).toBe(403);
      const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'requestId' = $2`, [orgA, denied.headers['x-request-id']]);
      expect(rows.map((r) => r.event), verb).toEqual([expect.objectContaining({ action: 'request.authorize', outcome: 'denied', actorId: u3, reason: 'missing_permission:forms.edit' })]);
    }
    expect((await state(id)).lifecycle).toBe('active');
  });
});
