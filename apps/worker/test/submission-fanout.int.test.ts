import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createPgBossQueue, installQueueSchema, parseJobKeyring, type PgBossQueue } from '@form/adapters/queue';
import { createDb, newSubmissionKey, provision, type DbHandle } from '@form/db';
import { toIsoInstant, type JobRequest, type SubmissionEvent } from '@form/ports';
import { createTestDatabase } from '@form/testkit';
import { jobGuard } from '../src/guard.ts';
import { createSubmissionFanout, JOB_DEFINITIONS, submissionFanout, type FanoutTarget } from '../src/jobs/index.ts';
import { startWorker } from '../src/runtime.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

/*
 * WP-1.12: the `submission.fanout` handler. A committed response sends one job; the handler loads the response as
 * `system` in the tenant of the org that owns the form and hands it to the consumers. There are none yet, so the
 * handler acks. These tests give it a consumer of their own to see what the handler found.
 */

interface Org {
  id: string;
  form: string;
  other: string;
  versions: Record<string, string>;
}

const log = pino({ level: 'silent' });
const secret = () => randomBytes(32).toString('base64url');

let owner: pg.Pool;
let app: DbHandle;
let producer: PgBossQueue;
let a: Org;
let b: Org;
const queues: PgBossQueue[] = [];
const queueErrors: Error[] = [];
let url: string;
let keySecret: string;

async function seedOrg(slug: string): Promise<Org> {
  const org: Org = { id: randomUUID(), form: randomUUID(), other: randomUUID(), versions: {} };
  const user = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [org.id, slug]);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [user, `owner@${slug}.test`]);
  for (const form of [org.form, org.other]) {
    await owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [form, org.id, randomUUID(), user, `${slug} form`]);
    org.versions[form] = randomUUID();
    await owner.query(
      `insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash) values ($1, $2, $3, 1, 2, $4, '{}', '{}', $5)`,
      [org.versions[form], org.id, form, user, '0'.repeat(64)],
    );
  }
  return org;
}

/** A response received now (the current month always has a partition), as the submit route stores one. */
async function store(org: Org, o: { form?: string; status?: string } = {}): Promise<{ id: string; receivedAt: Date; form: string }> {
  const form = o.form ?? org.form;
  const { id, receivedAt } = newSubmissionKey(new Date());
  await owner.query(
    `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta)
     values ($1, $2, $3, $4, $5, $6, 0, $7, '{"name":{"type":"short_text","value":"Asha"}}', '{}', '{"locale":"en-IN"}')`,
    [id, receivedAt, org.id, form, org.versions[form], Buffer.alloc(32), o.status ?? 'complete'],
  );
  return { id, receivedAt, form };
}

/** The job the API's submit transaction sends: the form is the resource, the data holds ids and the event. */
const fanoutFor = (org: Org, key: { id: string; receivedAt: Date }, o: { event?: SubmissionEvent; form?: string } = {}): JobRequest<'submission.fanout'> => ({
  orgId: org.id,
  resource: { type: 'form', id: o.form ?? org.form },
  data: { submissionId: key.id, receivedAt: toIsoInstant(key.receivedAt), event: o.event ?? 'created' },
});

async function jobState(id: string): Promise<string | undefined> {
  const { rows } = await owner.query<{ state: string }>('select state from pgboss.job where id = $1', [id]);
  return rows[0]?.state;
}

/** Waits for the job to be finished, and returns how it ended. */
const finished = (id: string): Promise<string> =>
  vi.waitFor(
    async () => {
      const state = await jobState(id);
      expect(['completed', 'failed', 'cancelled']).toContain(state);
      return state!;
    },
    { timeout: 20_000, interval: 200 },
  );

function workerQueue(): PgBossQueue {
  const q = createPgBossQueue({
    connectionString: url,
    keyring: parseJobKeyring(`t1:${keySecret}`),
    mode: 'worker',
    applicationName: 'fr-worker-fanout-test',
    pollingIntervalSeconds: 0.5,
    ...jobGuard(app.db, log),
    onError: (err) => queueErrors.push(err),
  });
  queues.push(q);
  return q;
}

/** A worker serving only `jobs`; it is stopped with the suite, or sooner by its caller. */
async function serve(jobs: Parameters<typeof startWorker>[0]['jobs']): Promise<PgBossQueue> {
  const queue = workerQueue();
  await queue.start();
  await startWorker({ db: app.db, log, queue, jobs });
  return queue;
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_worker_fanout');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  url = urls.fr_app;
  await installQueueSchema({ connectionString: urls.fr_migrator, appRole: 'fr_app' });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  app = createDb(urls.fr_app, { max: 6, applicationName: 'fr-worker-fanout-test' });
  keySecret = secret();
  producer = createPgBossQueue({ connectionString: urls.fr_app, keyring: parseJobKeyring(`t1:${keySecret}`), mode: 'producer', onError: (err) => queueErrors.push(err) });
  queues.push(producer);
  await producer.start();
  a = await seedOrg('fanout-a');
  b = await seedOrg('fanout-b');
});

afterAll(async () => {
  for (const q of queues) await q.stop({ graceMs: 1000 });
  await app?.close();
  await owner?.end();
});

describe('submission.fanout', () => {
  const seen: FanoutTarget[] = [];
  /** What the handler found, in the order it was asked. A consumer of our own stands in for the ones that come later. */
  const recorder = async (target: FanoutTarget): Promise<void> => {
    seen.push(target);
  };

  let worker: PgBossQueue;
  beforeAll(async () => {
    worker = await serve([createSubmissionFanout([recorder])]);
  });
  // The registered handler is tested below on its own, so this worker must not take its jobs.
  afterAll(() => worker.stop({ graceMs: 1000 }));

  it('acks a created event for a stored response, and tells its consumers the ids and status, never an answer', async () => {
    const s = await store(a);
    const id = await producer.send('submission.fanout', fanoutFor(a, s));
    expect(await finished(id!)).toBe('completed');
    expect(seen.filter((t) => t.submissionId === s.id)).toEqual([
      { orgId: a.id, formId: a.form, formVersionId: a.versions[a.form], submissionId: s.id, status: 'complete', event: 'created' },
    ]);
    expect(JSON.stringify(seen)).not.toContain('Asha');
  });

  it.each(['updated', 'released'] as const)('acks a %s event too', async (event) => {
    const s = await store(a);
    const id = await producer.send('submission.fanout', fanoutFor(a, s, { event }));
    expect(await finished(id!)).toBe('completed');
    expect(seen.find((t) => t.submissionId === s.id)).toMatchObject({ event });
  });

  it('acks and does nothing for a submission that is not there', async () => {
    const before = seen.length;
    const gone = newSubmissionKey(new Date());
    const id = await producer.send('submission.fanout', fanoutFor(a, gone));
    expect(await finished(id!)).toBe('completed');
    expect(seen).toHaveLength(before);
  });

  it('does nothing for an id that is not even a UUIDv7 (it can name no submission), and acks', async () => {
    const before = seen.length;
    const id = await producer.send('submission.fanout', fanoutFor(a, { id: randomUUID(), receivedAt: new Date() }));
    expect(await finished(id!)).toBe('completed');
    expect(seen).toHaveLength(before);
  });

  it('does not find another org’s submission under this org’s form: RLS answers for the tenant the job runs in', async () => {
    const before = seen.length;
    const theirs = await store(b);
    const id = await producer.send('submission.fanout', fanoutFor(a, theirs));
    expect(await finished(id!)).toBe('completed');
    expect(seen).toHaveLength(before);
  });

  it('does not take a response of another form of the same org for the form the job names', async () => {
    const before = seen.length;
    const elsewhere = await store(a, { form: a.other });
    const id = await producer.send('submission.fanout', fanoutFor(a, elsewhere));
    expect(await finished(id!)).toBe('completed');
    expect(seen).toHaveLength(before);
    // The same response named under its own form is found.
    const own = await producer.send('submission.fanout', fanoutFor(a, elsewhere, { form: a.other }));
    expect(await finished(own!)).toBe('completed');
    expect(seen.at(-1)).toMatchObject({ submissionId: elsewhere.id, formId: a.other });
  });

  it('hands a held response to the consumers with its status, so each can decide what a held one may do', async () => {
    const s = await store(a, { status: 'pending_payment' });
    const id = await producer.send('submission.fanout', fanoutFor(a, s));
    expect(await finished(id!)).toBe('completed');
    expect(seen.find((t) => t.submissionId === s.id)).toMatchObject({ status: 'pending_payment' });
  });
});

describe('the registered handler', () => {
  it('is in the worker’s registry, serves the queue, and acks with no consumers', async () => {
    expect(JOB_DEFINITIONS).toContain(submissionFanout);
    expect(submissionFanout).toMatchObject({ name: 'submission.fanout', perms: [] });
    await serve([submissionFanout]);
    const s = await store(b);
    const stored = await producer.send('submission.fanout', fanoutFor(b, s));
    expect(await finished(stored!)).toBe('completed');
    const unknown = await producer.send('submission.fanout', fanoutFor(b, newSubmissionKey(new Date())));
    expect(await finished(unknown!)).toBe('completed');
  });
});
