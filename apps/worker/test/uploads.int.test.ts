import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, newSubmissionKey, provision, type DbHandle } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { createUploadStore } from '../src/file-store.ts';
import { createUploadJobs, removeUnattachedUploads, UNATTACHED_AFTER_HOURS } from '../src/jobs/index.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

interface Org {
  id: string;
  form: string;
  other: string;
  /** The version each form's responses are filed under, by form id. */
  versions: Record<string, string>;
}

const log = pino({ level: 'silent' });
let owner: pg.Pool;
let app: DbHandle;
let dir: string;
let a: Org;
let b: Org;

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

/** A file row `ageHours` old, with its bytes on disk. */
async function upload(org: Org, ageHours: number, form = org.form): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `insert into form_files (id, org_id, form_id, block_id, name, mime, size_bytes, sha256, created_at)
     values ($1, $2, $3, 'cv', 'cv.pdf', 'application/pdf', 4, $4, now() - make_interval(hours => $5::int))`,
    [id, org.id, form, '0'.repeat(64), ageHours],
  );
  await writeFile(path.join(dir, `${id}.bin`), 'data');
  return id;
}

const rowExists = async (id: string) => (await owner.query('select 1 from form_files where id = $1', [id])).rowCount === 1;
const bytesExist = (id: string) => existsSync(path.join(dir, `${id}.bin`));
/** A response received now (the current month always has a partition), as the submit route stores one. */
async function submit(org: Org, answers: unknown, form = org.form): Promise<{ id: string; receivedAt: Date }> {
  const { id, receivedAt } = newSubmissionKey(new Date());
  await owner.query(
    `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta)
     values ($1, $2, $3, $4, $5, $6, 0, 'complete', $7, '{}', '{"locale":"en-IN"}')`,
    [id, receivedAt, org.id, form, org.versions[form], Buffer.alloc(32), JSON.stringify(answers)],
  );
  return { id, receivedAt };
}
const names = (...ids: string[]) => ({ cv: { type: 'file_upload', value: ids.map((fileId) => ({ fileId, name: 'cv.pdf' })) } });

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_worker_uploads');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  app = createDb(urls.fr_app, { max: 4, applicationName: 'fr-worker-uploads-test' });
  dir = await mkdtemp(path.join(tmpdir(), 'fr-worker-files-'));
  a = await seedOrg('uploads-a');
  b = await seedOrg('uploads-b');
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await rm(dir, { recursive: true, force: true });
});

describe('the upload sweep (drafts.expire)', () => {
  const files = () => createUploadStore(dir);

  it('removes an unattached file older than a day, row and bytes, and keeps a young one', async () => {
    const old = await upload(a, UNATTACHED_AFTER_HOURS + 6);
    const young = await upload(a, 1);
    expect(await removeUnattachedUploads(app.db, a.id, { files: files() })).toBeGreaterThanOrEqual(1);
    expect([await rowExists(old), bytesExist(old)]).toEqual([false, false]);
    expect([await rowExists(young), bytesExist(young)]).toEqual([true, true]);
  });

  it('keeps a file a submission holds, however old, and removes it once that submission is deleted', async () => {
    const held = await upload(a, 100);
    const stored = await submit(a, names(held));
    // The insert trigger linked the file to the submission, by both columns of its key.
    expect((await owner.query('select submission_id, submission_received_at from form_files where id = $1', [held])).rows[0]).toEqual({
      submission_id: stored.id,
      submission_received_at: stored.receivedAt,
    });
    await removeUnattachedUploads(app.db, a.id, { files: files() });
    expect([await rowExists(held), bytesExist(held)]).toEqual([true, true]);
    // Deleting the submission un-holds the file (on delete set null); the next sweep takes its row and bytes.
    await owner.query('delete from submissions where id = $1 and received_at = $2', [stored.id, stored.receivedAt]);
    expect((await owner.query('select submission_id, submission_received_at from form_files where id = $1', [held])).rows[0]).toEqual({
      submission_id: null,
      submission_received_at: null,
    });
    await removeUnattachedUploads(app.db, a.id, { files: files() });
    expect([await rowExists(held), bytesExist(held)]).toEqual([false, false]);
  });

  it('keeps a file that is unlinked but that a submission of the form still names', async () => {
    const id = randomUUID();
    // The submission was stored before the file row existed, so the trigger had nothing to link.
    await submit(a, names(id));
    await owner.query(
      `insert into form_files (id, org_id, form_id, block_id, name, mime, size_bytes, sha256, created_at)
       values ($1, $2, $3, 'cv', 'cv.pdf', 'application/pdf', 4, $4, now() - interval '2 days')`,
      [id, a.id, a.form, '0'.repeat(64)],
    );
    await writeFile(path.join(dir, `${id}.bin`), 'data');
    await removeUnattachedUploads(app.db, a.id, { files: files() });
    expect([await rowExists(id), bytesExist(id)]).toEqual([true, true]);
  });

  it('does not take a file named only in a submission of another form', async () => {
    const orphan = await upload(a, 72, a.form);
    await submit(a, names(orphan), a.other);
    await removeUnattachedUploads(app.db, a.id, { files: files() });
    expect(await rowExists(orphan)).toBe(false);
  });

  it('works through many in batches, one org at a time, and never touches another org’s rows', async () => {
    const mine = await Promise.all(Array.from({ length: 5 }, () => upload(a, 48)));
    const theirs = await upload(b, 48);
    expect(await removeUnattachedUploads(app.db, a.id, { files: files(), batch: 2 })).toBe(5);
    for (const id of mine) expect([await rowExists(id), bytesExist(id)]).toEqual([false, false]);
    expect([await rowExists(theirs), bytesExist(theirs)]).toEqual([true, true]);
    expect(await removeUnattachedUploads(app.db, b.id, { files: files() })).toBe(1);
    expect([await rowExists(theirs), bytesExist(theirs)]).toEqual([false, false]);
  });

  it('removes the row even when its bytes are already gone, and logs, never throws, when the bytes cannot be removed', async () => {
    const gone = await upload(a, 48);
    await rm(path.join(dir, `${gone}.bin`));
    expect(await removeUnattachedUploads(app.db, a.id, { files: files() })).toBe(1);
    expect(await rowExists(gone)).toBe(false);
    const stuck = await upload(a, 48);
    const failing = { remove: async () => Promise.reject(new Error('EBUSY')) };
    const warned: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => warned.push(args) } as unknown as pino.Logger;
    expect(await removeUnattachedUploads(app.db, a.id, { files: failing, log: logger })).toBe(1);
    expect(warned).toHaveLength(1);
    expect(await rowExists(stuck)).toBe(false);
  });

  it('runs as the drafts.expire job: every org, as the system actor, on an hourly cron', async () => {
    const [def] = createUploadJobs({ files: files() });
    expect(def).toMatchObject({ name: 'drafts.expire', perms: [], cron: expect.stringMatching(/^\d+ \* \* \* \*$/) });
    const x = await upload(a, 60);
    const y = await upload(b, 60);
    const young = await upload(b, 2);
    const ac = new AbortController();
    const job = { id: 'job-1', signal: { aborted: false, throwIfAborted: () => ac.signal.throwIfAborted() } };
    await (def as unknown as { run(ctx: unknown): Promise<void> }).run({ kind: 'system', db: app.db, log, job });
    expect([await rowExists(x), await rowExists(y), await rowExists(young)]).toEqual([false, false, true]);
    expect([bytesExist(x), bytesExist(y), bytesExist(young)]).toEqual([false, false, true]);
    // An aborted job stops before touching anything.
    const left = await upload(a, 60);
    ac.abort();
    await expect((def as unknown as { run(ctx: unknown): Promise<void> }).run({ kind: 'system', db: app.db, log, job })).rejects.toThrow();
    expect(await rowExists(left)).toBe(true);
  });
});

describe('the upload store', () => {
  it('removes by uuid only, and a file that is not there is already removed', async () => {
    const store = createUploadStore(dir);
    const id = randomUUID();
    await writeFile(path.join(dir, `${id}.bin`), 'x');
    await store.remove(id);
    expect(bytesExist(id)).toBe(false);
    await expect(store.remove(id)).resolves.toBeUndefined();
    for (const bad of ['../x', '..', `${id}/../x`, `${id}.bin`, '']) await expect(store.remove(bad), bad).rejects.toThrow(TypeError);
  });
});
