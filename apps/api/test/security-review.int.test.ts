/*
 * SECURITY REVIEW PROOFS (adversarial review of 4b022eaf^..21ccb166, 15 Nov 2026).
 *
 * Every test in this file FAILS on the reviewed code on purpose: each one states the behaviour the platform should
 * have, and the failure is the proof of the finding. Turn each into a fix (and keep the test) rather than deleting it.
 * Finding ids (SR-n) match the review report.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import v8 from 'node:v8';
import vm from 'node:vm';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, provision, withTenant, type DbHandle } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { createFileStore } from '../src/files.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
/**
 * Plain notes, what a respondent really uploads as notes.txt. The proof used a Windows program (MZ header) here, which
 * passed the old upload check; the SR-7 fix refuses it at upload, so the rename is shown with a file the check approves.
 */
const NOTES = Buffer.from('Meeting notes, 15 Nov\n');

let app: FastifyInstance;
let owner: pg.Pool;
let appDb: DbHandle;
let dir: string;
let orgId: string;
let userId: string;
const logLines: string[] = [];

const as = () => ({ 'x-fr-dev-user': userId, 'x-fr-org': orgId, ...BROWSER });
const text = (value: string) => ({ type: 'short_text', value });

type Block = ReturnType<typeof fieldBlock>;

async function publish(title: string, blocks: Block[], body: Record<string, unknown> = {}): Promise<{ id: string; slug: string; versionId: string }> {
  const { id } = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(), payload: { title } })).json<{ id: string }>();
  const put = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: as(), payload: { draft: draftWith(id, blocks, title) } });
  expect(put.statusCode, put.body).toBe(200);
  const live = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(), payload: body });
  expect(live.statusCode, live.body).toBe(200);
  return { id, ...live.json<{ slug: string; versionId: string }>() };
}

async function upload(slug: string, blockId: string, name: string, mime: string, bytes: Buffer, purpose: 'file' | 'signature' = 'file') {
  const res = await app.inject({ method: 'POST', url: `/v1/p/${slug}/files`, payload: { blockId, purpose, name, mime, data: bytes.toString('base64') } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ fileId: string; name: string; sizeBytes: number; mime: string; sha256: string; scan: 'skipped' }>();
}

const submit = (slug: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/v1/p/${slug}/submissions`, payload: { locale: 'en-IN', fields: [], ...body } });

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_secreview');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  appDb = createDb(urls.fr_app, { max: 2 });
  dir = await mkdtemp(path.join(tmpdir(), 'fr-secreview-'));
  orgId = randomUUID();
  userId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'secreview']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@secreview.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);
  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'info' });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  const logStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logLines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      cb();
    },
  });
  app = await buildApp(parsed.config, { underPressure: false, files: createFileStore(dir), logStream });
});

afterAll(async () => {
  await app?.close();
  await appDb?.close();
  await owner?.end();
  await rm(dir, { recursive: true, force: true });
});

describe('SR-1: a file reference in the answers is bound to the stored file only by id, size and hash', () => {
  it('keeps the name and type the respondent typed into the answer, not the ones the upload check approved', async () => {
    // A field that leaves the type open (both accept lists empty): the upload route falls back to DEFAULT_ACCEPT
    // (txt allowed), but the answer validation treats empty lists as "anything".
    const form = await publish('SR1 rename', [fieldBlock('doc', 'file_upload', { accept: { extensions: [], mimeTypes: [] } })]);
    // A text file, uploaded as notes.txt: the upload check approves it as exactly that.
    const file = await upload(form.slug, 'doc', 'notes.txt', 'text/plain', NOTES);
    expect(file.name).toBe('notes.txt');
    // The answer renames it. The Responses page offers it as <a href=blob: download="Invoice-0423.exe">, and a blob
    // URL's download name wins over the API's Content-Disposition.
    const res = await submit(form.slug, {
      formVersionId: form.versionId,
      answers: { doc: { type: 'file_upload', value: [{ ...file, name: 'Invoice-0423.exe', mime: 'application/pdf' }] } },
    });
    const { rows } = await owner.query('select answers from form_submissions where form_id = $1', [form.id]);
    const storedName = (rows[0]?.answers as { doc?: { value?: Array<{ name?: string }> } } | undefined)?.doc?.value?.[0]?.name;
    // Wanted: refused, or the reference rewritten from the form_files row (name notes.txt).
    expect(res.statusCode === 400 || storedName === 'notes.txt', `status ${res.statusCode}, stored name ${storedName}`).toBe(true);
  });

  it('lets a file uploaded through one field stand in an answer to another field with stricter type rules', async () => {
    const form = await publish('SR1 cross-field', [
      fieldBlock('photo', 'file_upload', { accept: { extensions: ['png'], mimeTypes: ['image/png'] } }),
      fieldBlock('cv', 'file_upload', { accept: { extensions: ['pdf'], mimeTypes: ['application/pdf'] } }),
    ]);
    const png = await upload(form.slug, 'photo', 'me.png', 'image/png', PNG);
    // The PNG goes into the PDF-only field, relabelled; form_files.block_id says "photo", nobody compares.
    const res = await submit(form.slug, {
      formVersionId: form.versionId,
      answers: { cv: { type: 'file_upload', value: [{ ...png, name: 'cv.pdf', mime: 'application/pdf' }] } },
    });
    expect(res.statusCode, 'a file uploaded to "photo" accepted as the answer to "cv"').toBe(400);
  });
});

describe('SR-2: the display rows a respondent sends are stored and shown as the response', () => {
  it('stores rows for fields the form does not have, next to answers that say nothing', async () => {
    const form = await publish('SR2 rows', [fieldBlock('comment', 'short_text')]);
    const forged = [{ key: 'approval', label: 'Approved by HR', value: 'Yes - pay in full' }];
    const res = await submit(form.slug, { formVersionId: form.versionId, answers: {}, fields: forged });
    // The Responses page rebuilds rows from the answers, and falls back to these rows when that gives none.
    if (res.statusCode === 200) {
      const { rows } = await owner.query('select fields from form_submissions where id = $1', [res.json<{ id: string }>().id]);
      expect(JSON.stringify(rows[0]?.fields), 'forged display row stored').not.toContain('Approved by HR');
    } else {
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('SR-3: answers that Postgres cannot store end as an anonymous 500, logged with answer text', () => {
  it('answers 400, and keeps answer text out of the logs, for a NUL in a display row', async () => {
    const form = await publish('SR3 nul', [fieldBlock('comment', 'short_text')]);
    logLines.length = 0;
    const res = await submit(form.slug, {
      formVersionId: form.versionId,
      answers: { comment: text('fine') },
      fields: [{ key: 'pan', label: 'PAN', value: 'ABCDE1234F-SECRET-PII' }, { key: 'x', label: 'x', value: 'a\u0000b' }],
    });
    const leaked = logLines.filter((l) => l.includes('SECRET-PII'));
    expect({ status: res.statusCode, leakedLogLines: leaked.length }).toEqual({ status: 400, leakedLogLines: 0 });
  });

  it('answers 400 for a locale that is not a language tag (it is stored as sent, and handed to Intl)', async () => {
    const form = await publish('SR3 locale', [fieldBlock('comment', 'short_text')]);
    const res = await submit(form.slug, { formVersionId: form.versionId, answers: { comment: text('ok') }, locale: '<script>x' });
    expect(res.statusCode).toBe(400);
  });

  it('answers 400 for a NUL in an answer', async () => {
    const form = await publish('SR3 nul answer', [fieldBlock('comment', 'short_text')]);
    const res = await submit(form.slug, { formVersionId: form.versionId, answers: { comment: text('x\u0000y') } });
    expect(res.statusCode).toBe(400);
  });
});

describe('SR-4: an anonymous upload is read and parsed in full before anything about the form is checked', () => {
  it('turns away a 12 MB body for a slug that does not exist without parsing it', async () => {
    // Not JSON: if the slug were checked first this would be a 404; a 400 "invalid JSON" proves the 12 MB was
    // buffered and handed to JSON.parse first (up to UPLOAD_BODY_LIMIT, ~14 MB, per request, with no rate limit).
    const body = `{"blockId":"x","name":"a","mime":"a","data":"${'A'.repeat(12 * 1024 * 1024)}`;
    const res = await app.inject({ method: 'POST', url: '/v1/p/no-such-form-anywhere/files', headers: { 'content-type': 'application/json' }, payload: body });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(404);
  });

  it('turns away a body bigger than the form can take before parsing it', async () => {
    const form = await publish('SR4 small', [fieldBlock('doc', 'file_upload', { maxFileBytes: 100 * 1024, accept: { extensions: ['pdf'], mimeTypes: ['application/pdf'] } })]);
    const body = `{"blockId":"doc","name":"a.pdf","mime":"application/pdf","data":"${'A'.repeat(12 * 1024 * 1024)}`;
    const res = await app.inject({ method: 'POST', url: `/v1/p/${form.slug}/files`, headers: { 'content-type': 'application/json' }, payload: body });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(413);
  });
});

describe('SR-5: respondent and no-permission contexts see every submission and file of the org (no data-access policy)', () => {
  it('a respondent transaction (the public routes) cannot read or delete submissions and files', async () => {
    const form = await publish('SR5', [fieldBlock('comment', 'short_text'), fieldBlock('doc', 'file_upload', { accept: { extensions: ['png'], mimeTypes: ['image/png'] } })]);
    await upload(form.slug, 'doc', 'me.png', 'image/png', PNG);
    expect((await submit(form.slug, { formVersionId: form.versionId, answers: { comment: text('private answer') } })).statusCode).toBe(200);
    // The context POST /v1/p/:slug/* runs in: architecture §2.2 says a bug there "cannot expose the tenant".
    const seen = await withTenant(appDb.db, { orgId, actor: 'respondent', requestId: 'sr5' }, async (tx) => {
      const subs = await tx.execute<{ n: string }>(sql`select count(*)::text as n from form_submissions`);
      const files = await tx.execute<{ n: string }>(sql`select count(*)::text as n from form_files`);
      const deleted = await tx.execute(sql`delete from form_files where form_id = ${form.id}`);
      // Thrown to roll the delete back; the counts travel with it.
      throw { seen: { submissions: Number(subs.rows[0]!.n), files: Number(files.rows[0]!.n), deletedFiles: deleted.rowCount ?? 0 } };
    }).catch((err: unknown) => (err && typeof err === 'object' && 'seen' in err ? (err as { seen: unknown }).seen : { error: String(err) }));
    expect(seen).toEqual({ submissions: 0, files: 0, deletedFiles: 0 });
  });

  it('a member context without submissions.read (role creator) cannot read submissions', async () => {
    const seen = await withTenant(appDb.db, { orgId, actor: 'user', userId, perms: ['forms.create', 'forms.edit', 'forms.publish', 'forms.read'], requestId: 'sr5b', readOnly: true }, async (tx) => {
      const subs = await tx.execute<{ n: string }>(sql`select count(*)::text as n from form_submissions`);
      return Number(subs.rows[0]!.n);
    });
    expect(seen).toBe(0);
  });
});

describe('SR-6: publish media is cached per live version without a byte bound', () => {
  it('keeps the API heap bounded when one account publishes and opens many picture-heavy versions', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    // Two pictures of ~3.5 MB each (the publish route takes 3M characters per picture, 64 pictures, 8 MB per request).
    const pic = (seed: string) => `data:image/jpeg;base64,${Buffer.alloc(2_200_000, seed).toString('base64')}`;
    const blocks = [fieldBlock('comment', 'short_text')];
    const { id } = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(), payload: { title: 'SR6' } })).json<{ id: string }>();
    const draft = draftWith(id, blocks, 'SR6') as unknown as Record<string, unknown>;
    (draft['theme'] as { tokens: Record<string, unknown> }).tokens['cover'] = { image: { assetId: 'cover_a' }, heightPx: 200 };
    (draft['theme'] as { tokens: Record<string, unknown> }).tokens['background'] = { kind: 'image', image: { assetId: 'bg_a' }, fit: 'cover' };
    const put = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: as(), payload: { draft } });
    expect(put.statusCode, put.body).toBe(200);
    gc();
    const before = process.memoryUsage().heapUsed;
    const versions = 20;
    for (let i = 0; i < versions; i++) {
      const live = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(), payload: { media: { cover_a: pic(`c${i}`), bg_a: pic(`b${i}`) } } });
      expect(live.statusCode, live.body.slice(0, 200)).toBe(200);
      // Anyone opening the link loads the new version into the 200-entry cache; earlier versions stay there.
      const opened = await app.inject({ url: `/v1/p/${live.json<{ slug: string }>().slug}` });
      expect(opened.statusCode).toBe(200);
    }
    gc();
    const grownMiB = (process.memoryUsage().heapUsed - before) / 2 ** 20;
    // ~6 MB of media per version stays referenced from liveByVersion; at LIVE_CACHE_MAX (200) that is over 1 GB.
    expect(Math.round(grownMiB), `heap grew ${grownMiB.toFixed(0)} MiB for ${versions} versions`).toBeLessThan(64);
  });
});
