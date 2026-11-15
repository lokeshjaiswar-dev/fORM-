import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPgBossQueue, installQueueSchema, parseJobKeyring, type PgBossQueue } from '@form/adapters/queue';
import { createPostgresSearchIndex } from '@form/adapters/search';
import { provision } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { createFileStore } from '../src/files.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { answersFor, FIELD_COUNT, form50Draft, hiddenWhenFired, RULE_COUNT } from './fixtures/form-50-fields.ts';

/**
 * WP-1.12 performance: the submit path of a 50-field form with 10 show/hide rules, under 50 concurrent clients, 20 submits
 * each (1 000 submits), over real HTTP (`app.listen`, and Node's built-in fetch, which is undici, in a worker thread so
 * that the clients' own work does not take the server's event loop) with a unique Idempotency-Key for each. Every submit
 * does the whole job of the path: the evaluation and validation of the 50 answers, the idempotency claim, the search
 * document, the `submission.fanout` job, the counter and the INSERT with its triggers. Off unless `FORM_PERF=1`, and
 * excluded from the default `test:int` run (vitest.int.config.ts): it runs on the build server.
 *
 * Two runs of the same 1 000 submits, after one warm-up submit per client (the version loads and the code compiles on the
 * first requests; those 50 are left out of the figures):
 *
 *  - THE CHECK: 50 requests per second, which is the plan's figure ("p95 < 150 ms for a 50-field form at 50 RPS on one
 *    node", WP-1.12). Each of the 50 clients sends one submit a second, at a phase of its own, so 50 connections are
 *    open and 50 requests a second arrive. p95 must stay under 150 ms times `FORM_PERF_SLACK` (default 2, because a shared
 *    CI machine is slower than the one the target was set on), and nothing may fail.
 *  - THE SATURATION RUN: the same clients with no pause, so the server is the bottleneck and p95 is the queue of 50
 *    requests for one event loop. It prints what one node can take and how the latency grows; it asserts no failure and
 *    the stored counts, and no latency, because that figure is the single-node throughput (WP-1.28 sets its target: 500
 *    submits a second for one form), not the plan's.
 *
 * What is timed is the SERVER's time, taken in an `onResponse` hook (`reply.elapsedTime`: from the request reaching
 * Fastify to the response being sent), so the client's own work and the loopback do not count. It prints p50, p95, p99,
 * the slowest and the requests per second of each run on stderr. `FORM_PERF_RPS` changes the checked rate (default 50).
 */

const ENABLED = process.env.FORM_PERF === '1';
const SLACK = Number(process.env.FORM_PERF_SLACK ?? '2') || 2;
const RPS = Number(process.env.FORM_PERF_RPS ?? '50') || 50;
const TARGET_MS = 150;
const LIMIT_MS = TARGET_MS * SLACK;
const CLIENTS = 50;
const SUBMITS_PER_CLIENT = 20;
const TOTAL = CLIENTS * SUBMITS_PER_CLIENT;
/** Each client's pause between submits, in milliseconds, so that all of them together send `RPS` a second. */
const PACE_MS = (CLIENTS / RPS) * 1000;

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;

const report = (line: string): void => {
  process.stderr.write(`[submit perf] ${line}\n`);
};

/** The value below which `p` of the sorted `samples` fall (nearest rank). */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

/**
 * The clients, run in a worker thread: `clients` loops, each sending its `each` bodies one after another with a unique
 * Idempotency-Key and waiting for the whole response. With `paceMs` a client sends its next submit that long after the
 * previous one was sent (at a phase of its own, so the clients do not move in lockstep), or at once when the response was
 * slower than that. Plain JavaScript, because a worker made from a string has no TypeScript loader. Reports what went
 * wrong (any status but 200) and how long each exchange took from the client.
 */
const CLIENT_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  const { url, clients, each, bodies, paceMs } = workerData;
  const failures = [];
  const clientMs = [];
  const started = performance.now();
  await Promise.all(
    Array.from({ length: clients }, async (_, client) => {
      const phase = paceMs > 0 ? (client / clients) * paceMs : 0;
      for (let i = 0; i < each; i++) {
        if (paceMs > 0) await sleep(Math.max(0, started + phase + i * paceMs - performance.now()));
        const at = performance.now();
        try {
          const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: bodies[client * each + i] });
          const text = await res.text();
          if (res.status !== 200) failures.push(res.status + ' ' + text.slice(0, 200));
        } catch (err) {
          failures.push('fetch failed: ' + (err && err.message));
        }
        clientMs.push(performance.now() - at);
      }
    }),
  );
  parentPort.postMessage({ failures, seconds: (performance.now() - started) / 1000, clientMs });
})();
`;

interface Run {
  failures: string[];
  seconds: number;
  clientMs: number[];
}

describe.skipIf(!ENABLED)('submitting a 50-field form from 50 concurrent clients (FORM_PERF=1)', () => {
  let app: FastifyInstance;
  let queue: PgBossQueue;
  let owner: pg.Pool;
  let dir: string;
  let orgId: string;
  let userId: string;
  let formId: string;
  let slug: string;
  let versionId: string;
  let origin: string;
  /** Server time (ms) of each submit, by run; filled by the onResponse hook. */
  const serverMs: Record<'warmup' | 'paced' | 'saturated', number[]> = { warmup: [], paced: [], saturated: [] };
  let phase: keyof typeof serverMs | 'off' = 'off';
  /** The number of the next respondent: every submit of the file is a different respondent. */
  let respondent = 0;
  const headers = () => ({ 'x-fr-dev-user': userId, 'x-fr-org': orgId, ...BROWSER });

  beforeAll(async () => {
    const adminUrl = inject('pgAdminUrl');
    const database = await createTestDatabase(adminUrl, 'fr_api_submit_perf');
    const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
    await installQueueSchema({ connectionString: urls.fr_migrator, appRole: 'fr_app' });
    owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
    dir = await mkdtemp(path.join(tmpdir(), 'fr-submit-perf-'));
    [orgId, userId] = [randomUUID(), randomUUID()];
    await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'submit-perf']);
    await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@submit-perf.test']);
    await owner.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, userId]);
    // The default pool size: the run must hold at the settings a deployment starts with, not at a pool made for the test.
    const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    queue = createPgBossQueue({
      connectionString: urls.fr_app,
      keyring: parseJobKeyring(`perf:${Buffer.alloc(32, 9).toString('base64url')}`),
      mode: 'producer',
      max: 2,
      applicationName: 'fr-api-queue-perf',
    });
    await queue.start();
    // Everything `main.ts` wires: the search index and the producer queue. One address sends every request, so the
    // per-address submit budgets are lifted (they are tested on their own).
    const budget = { max: 1_000_000, windowSeconds: 600 };
    app = await buildApp(parsed.config, {
      underPressure: false,
      files: createFileStore(dir),
      searchIndex: createPostgresSearchIndex,
      queue,
      authLimits: { auth_submit_ip: budget, auth_submit_form: budget },
    });
    // Before `listen`: a hook added now applies to the routes already registered on the app.
    app.addHook('onResponse', (request, reply, done) => {
      if (phase !== 'off' && request.method === 'POST' && request.url.endsWith('/submissions')) serverMs[phase].push(reply.elapsedTime);
      done();
    });

    formId = (await app.inject({ method: 'POST', url: '/v1/forms', headers: headers(), payload: { title: 'Fifty fields' } })).json<{ id: string }>().id;
    const put = await app.inject({ method: 'PUT', url: `/v1/forms/${formId}/draft`, headers: { ...headers(), 'if-match': '0' }, payload: { draft: form50Draft(formId) } });
    expect(put.statusCode, put.body).toBe(200);
    const live = await app.inject({ method: 'POST', url: `/v1/forms/${formId}/publish`, headers: headers(), payload: {} });
    expect(live.statusCode, live.body).toBe(200);
    ({ slug, versionId } = live.json<{ slug: string; versionId: string }>());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('the app is not listening on a port');
    origin = `http://127.0.0.1:${address.port}`;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await queue?.stop({ graceMs: 1000 });
    await owner?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** `CLIENTS` clients at once, each sending `each` submits (paced by `paceMs`, or back to back); every submit is a new respondent. */
  async function load(name: keyof typeof serverMs, each: number, paceMs: number): Promise<Run> {
    // Every body is made before the clock starts, so the clients' time is the HTTP exchange and nothing else.
    const bodies = Array.from({ length: CLIENTS * each }, () => JSON.stringify({ formVersionId: versionId, answers: answersFor(respondent++), fields: [], locale: 'en-IN' }));
    const worker = new Worker(CLIENT_SCRIPT, { eval: true, workerData: { url: `${origin}/v1/p/${slug}/submissions`, clients: CLIENTS, each, bodies, paceMs } });
    phase = name;
    try {
      return await new Promise<Run>((resolve, reject) => {
        worker.once('message', (done: Run) => resolve(done));
        worker.once('error', reject);
        worker.once('exit', (code) => code === 0 || reject(new Error(`the load clients exited with code ${code}`)));
      });
    } finally {
      phase = 'off';
    }
  }

  const ms = (v: number) => `${v.toFixed(1)} ms`;
  const figures = (name: keyof typeof serverMs, run: Run): string => {
    const sorted = [...serverMs[name]].sort((a, b) => a - b);
    const client = [...run.clientMs].sort((a, b) => a - b);
    return (
      `${name}: ${sorted.length} submits, p50 ${ms(percentile(sorted, 0.5))}, p95 ${ms(percentile(sorted, 0.95))}, p99 ${ms(percentile(sorted, 0.99))}, max ${ms(sorted.at(-1) ?? Number.NaN)}; ` +
      `${(sorted.length / run.seconds).toFixed(0)} requests/s over ${run.seconds.toFixed(1)} s; client-side p95 ${ms(percentile(client, 0.95))}`
    );
  };

  it(`holds p95 under ${TARGET_MS} ms x ${SLACK} (slack) at ${RPS} requests a second from ${CLIENTS} concurrent clients, with no errors; then saturates it`, async () => {
    const warm = await load('warmup', 1, 0);
    expect(warm.failures).toEqual([]);

    const paced = await load('paced', SUBMITS_PER_CLIENT, PACE_MS);
    report(`${FIELD_COUNT} fields, ${RULE_COUNT} rules, ${CLIENTS} clients x ${SUBMITS_PER_CLIENT}, ${RPS} a second -> ${figures('paced', paced)}; limit ${LIMIT_MS} ms (target ${TARGET_MS} x slack ${SLACK})`);
    const saturated = await load('saturated', SUBMITS_PER_CLIENT, 0);
    report(`${FIELD_COUNT} fields, ${RULE_COUNT} rules, ${CLIENTS} clients x ${SUBMITS_PER_CLIENT}, no pause (one node's capacity) -> ${figures('saturated', saturated)}`);

    // Zero errors in both runs, and every submit is counted in the figures.
    expect(paced.failures).toEqual([]);
    expect(saturated.failures).toEqual([]);
    expect(serverMs.paced).toHaveLength(TOTAL);
    expect(serverMs.saturated).toHaveLength(TOTAL);
    const p95 = percentile([...serverMs.paced].sort((a, b) => a - b), 0.95);
    expect(p95, `p95 at ${RPS} requests a second`).toBeLessThan(LIMIT_MS);

    // What was timed is a real submit path, not a refusal: every response is stored once, with its search document and
    // its one fan-out job, and the rules did what the fixture says (a hidden field is not stored).
    const stored = CLIENTS + 2 * TOTAL;
    const n = async (text: string) => Number((await owner.query(text, [formId])).rows[0].n);
    expect(await n('select count(*) as n from submissions where form_id = $1')).toBe(stored);
    expect(await n('select count(*) as n from submission_search where form_id = $1')).toBe(stored);
    expect(await n(`select count(*) as n from pgboss.job where name = 'submission.fanout' and data -> 'resource' ->> 'id' = $1`)).toBe(stored);
    const { rows } = await owner.query<{ answers: Record<string, unknown> }>(`select answers from submissions where form_id = $1 and answers -> 'f01' ->> 'value' = 'hide' limit 1`, [formId]);
    for (const id of hiddenWhenFired()) expect(rows[0]!.answers, `${id} is hidden when its rule fires`).not.toHaveProperty(id);
    expect(Object.keys(rows[0]!.answers)).toHaveLength(FIELD_COUNT - RULE_COUNT);
  }, 600_000);
});
