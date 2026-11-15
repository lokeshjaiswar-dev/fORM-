import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, provision, type DbHandle } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

/**
 * WP-1.15 performance: a form with 100 000 responses pages in under 200 ms of server time, on the first page and on a
 * deep one. Off unless `FORM_PERF=1` (it seeds 100 000 rows, which the normal integration run should not pay for), and
 * the limit is the target times `FORM_PERF_SLACK` (default 2), as the other perf tests do, because a shared CI machine
 * is slower than the machine the target was set on.
 *
 * What is timed is `app.inject` of the grid request with the session of a member: routing, the permission check, the
 * transaction with its tenant settings, the page query, the plan lookups, the cell building, the audit record of the
 * page and the JSON, which is everything the server does for a page. The database is Postgres in a container, as in
 * production; the seed is plain SQL, so it takes seconds, not minutes.
 */

const ENABLED = process.env.FORM_PERF === '1';
const SLACK = Number(process.env.FORM_PERF_SLACK ?? '2') || 2;
const TARGET_MS = 200;
const LIMIT_MS = TARGET_MS * SLACK;
const ROWS = 100_000;
const PAGE = 200;
/** The deep page is this many pages in: 50 000 rows are behind it, half of the form. */
const DEEP_PAGE = 250;
const TRIALS = 7;
/** Responses seeded per statement (and per transaction). */
const BATCH = 2000;

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;

/** The timings, on stderr so the run's log keeps them (a passing test's console output is not shown). */
const report = (line: string): void => {
  process.stderr.write(`[grid perf] ${line}\n`);
};

describe.skipIf(!ENABLED)('the responses grid of a form with 100 000 responses (FORM_PERF=1)', () => {
  let app: FastifyInstance;
  let owner: pg.Pool;
  let appDb: DbHandle;
  let orgId: string;
  let userId: string;
  let formId: string;
  let versionId: string;
  const headers = () => ({ 'x-fr-dev-user': userId, 'x-fr-org': orgId, ...BROWSER });

  beforeAll(async () => {
    const adminUrl = inject('pgAdminUrl');
    const database = await createTestDatabase(adminUrl, 'fr_api_grid_perf');
    const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
    owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
    appDb = createDb(urls.fr_app, { max: 4 });
    [orgId, userId] = [randomUUID(), randomUUID()];
    await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'perf']);
    await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@perf.test']);
    await owner.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, userId]);
    const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    app = await buildApp(parsed.config, { underPressure: false });

    formId = (await app.inject({ method: 'POST', url: '/v1/forms', headers: headers(), payload: { title: 'Busy form' } })).json<{ id: string }>().id;
    const draft = draftWith(formId, [fieldBlock('name', 'short_text'), fieldBlock('city', 'short_text')], 'Busy form');
    expect((await app.inject({ method: 'PUT', url: `/v1/forms/${formId}/draft`, headers: { ...headers(), 'if-match': '0' }, payload: { draft } })).statusCode).toBe(200);
    const live = await app.inject({ method: 'POST', url: `/v1/forms/${formId}/publish`, headers: headers(), payload: {} });
    expect(live.statusCode, live.body).toBe(200);
    versionId = live.json<{ versionId: string }>().versionId;

    // One response every 77 seconds from the start of this month: about 89 days, inside the four monthly partitions the
    // database made. The id is a UUIDv7 made from its moment (48 bits of milliseconds, version 7, variant 8), and the
    // answers are two short texts; every third response is read and every seventh starred, as a working inbox would be.
    //
    // In batches of `BATCH`, each its own transaction: every insert fires the trigger that counts the response on the
    // form's row, and one transaction of 100 000 inserts would update that one row 100 000 times, which Postgres pays
    // for with ever longer chains of row versions (a quadratic cost that took more than ten minutes). The submit route
    // inserts one response per transaction, so this is also how the table is filled in use.
    const started = Date.now();
    for (let from = 1; from <= ROWS; from += BATCH) {
      await owner.query(
        `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta, read, starred)
         select u.id, uuid_v7_ts(u.id), v.org_id, v.form_id, v.id, decode(v.content_hash, 'hex'), 0, 'complete',
                jsonb_build_object('name', jsonb_build_object('type', 'short_text', 'value', 'Respondent ' || g),
                                   'city', jsonb_build_object('type', 'short_text', 'value', 'City ' || (g % 50))),
                '{}', '{"locale":"en-IN"}', g % 3 = 0, g % 7 = 0
         from form_versions v
         cross join generate_series($2::bigint, $3::bigint) as g
         cross join lateral (
           select (lpad(to_hex((extract(epoch from date_trunc('month', now() at time zone 'UTC') at time zone 'UTC') * 1000)::bigint + g * 77000), 12, '0')
                   || '7' || substr(md5('a' || g), 1, 3) || '8' || substr(md5('b' || g), 1, 3) || substr(md5('c' || g), 1, 12))::uuid as id) as u
         where v.id = $1`,
        [versionId, from, Math.min(from + BATCH - 1, ROWS)],
      );
    }
    // What autovacuum would have done by the time a form is this busy: statistics for the planner, and the visibility map.
    await owner.query('vacuum analyze submissions');
    report(`seeded ${ROWS} responses in ${Date.now() - started} ms`);
  }, 600_000);

  afterAll(async () => {
    await app?.close();
    await appDb?.close();
    await owner?.end();
  });

  const page = async (query: string) => {
    const started = performance.now();
    const res = await app.inject({ url: `/v1/forms/${formId}/submissions?${query}`, headers: headers() });
    const ms = performance.now() - started;
    expect(res.statusCode, res.body).toBe(200);
    return { ms, body: res.json<{ items: Array<{ id: string }>; nextCursor: string | null }>() };
  };

  /** The median of the trials: a single slow run (a checkpoint, a noisy neighbour) does not fail it, a slow query does. */
  async function timed(label: string, query: string): Promise<number> {
    await page(query);
    const runs: number[] = [];
    for (let i = 0; i < TRIALS; i += 1) runs.push((await page(query)).ms);
    runs.sort((a, b) => a - b);
    const median = runs[Math.floor(runs.length / 2)]!;
    report(`${label}: median ${median.toFixed(1)} ms, best ${runs[0]!.toFixed(1)} ms, worst ${runs.at(-1)!.toFixed(1)} ms (limit ${LIMIT_MS} ms)`);
    return median;
  }

  it('seeded every response, and nothing else is on the form', async () => {
    const { rows } = await owner.query<{ n: number }>('select count(*)::int as n from submissions where form_id = $1', [formId]);
    expect(rows[0]!.n).toBe(ROWS);
  });

  it('serves the first page in under 200 ms of server time (times the slack)', async () => {
    const first = await page(`limit=${PAGE}`);
    expect(first.body.items).toHaveLength(PAGE);
    expect(first.body.nextCursor).toBeTruthy();
    expect(await timed('first page', `limit=${PAGE}`)).toBeLessThan(LIMIT_MS);
  });

  it('serves a page 50 000 responses deep in under 200 ms of server time (times the slack): the cursor seeks, it does not skip', async () => {
    let cursor: string | null = null;
    let deep = '';
    const seen = new Set<string>();
    for (let n = 1; n <= DEEP_PAGE; n += 1) {
      const { body } = await page(`limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(body.items).toHaveLength(PAGE);
      for (const item of body.items) seen.add(item.id);
      if (n === DEEP_PAGE) {
        deep = `limit=${PAGE}&cursor=${encodeURIComponent(cursor!)}`;
        break;
      }
      cursor = body.nextCursor;
      expect(cursor, `page ${n} has a next page`).toBeTruthy();
    }
    // Every page walked was new rows: the cursor never repeats or loses one.
    expect(seen.size).toBe(DEEP_PAGE * PAGE);
    expect(await timed(`page ${DEEP_PAGE}`, deep)).toBeLessThan(LIMIT_MS);
  }, 300_000);

  it('serves a filtered first page (unread only) as fast', async () => {
    expect(await timed('unread first page', `limit=${PAGE}&read=false`)).toBeLessThan(LIMIT_MS);
  });
});
