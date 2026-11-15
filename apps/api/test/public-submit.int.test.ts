import { randomUUID } from 'node:crypto';
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

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');

let app: FastifyInstance;
let owner: pg.Pool;
let dir: string;
let orgId: string;
let userId: string;

const as = () => ({ 'x-fr-dev-user': userId, 'x-fr-org': orgId, ...BROWSER });
const name = (value: string) => ({ type: 'short_text', value });

const FIELDS = () => [
  fieldBlock('name', 'short_text', {}, { required: true }),
  fieldBlock('email', 'email'),
  fieldBlock('cv', 'file_upload', { accept: { extensions: ['pdf'], mimeTypes: ['application/pdf'] } }),
];

async function publish(title: string): Promise<{ id: string; slug: string; versionId: string }> {
  const { id } = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(), payload: { title } })).json<{ id: string }>();
  const put = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: as(), payload: { draft: draftWith(id, FIELDS(), title) } });
  expect(put.statusCode).toBe(200);
  const live = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(), payload: {} });
  expect(live.statusCode).toBe(200);
  return { id, ...live.json<{ slug: string; versionId: string }>() };
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_submit');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  dir = await mkdtemp(path.join(tmpdir(), 'fr-submit-'));
  orgId = randomUUID();
  userId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'submit']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@submit.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);
  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  app = await buildApp(parsed.config, { underPressure: false, files: createFileStore(dir) });
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await rm(dir, { recursive: true, force: true });
});

const submit = (slug: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/v1/p/${slug}/submissions`, payload: { locale: 'en-IN', fields: [], ...body } });

async function rows(formId: string): Promise<Array<{ id: string; org_id: string; answers: Record<string, unknown>; locale: string }>> {
  return (await owner.query('select id, org_id, answers, locale from form_submissions where form_id = $1', [formId])).rows;
}

describe('POST /v1/p/by-form/:formId/submissions', () => {
  it('is gone: a form id is not a way to write submissions to a form', async () => {
    const { id } = await publish('By id');
    const res = await app.inject({ method: 'POST', url: `/v1/p/by-form/${id}/submissions`, payload: { answers: { name: name('x') }, fields: [], locale: 'en-IN' } });
    expect(res.statusCode).toBe(404);
    expect(await rows(id)).toEqual([]);
    // Nor does a made-up form id write anything anywhere.
    const stranger = randomUUID();
    expect((await app.inject({ method: 'POST', url: `/v1/p/by-form/${stranger}/submissions`, payload: { answers: {}, fields: [] } })).statusCode).toBe(404);
  });
});

describe('POST /v1/p/:slug/submissions', () => {
  it('stores valid answers in Postgres, under the form’s org, and counts them', async () => {
    const { id, slug, versionId } = await publish('Valid');
    const res = await submit(slug, { formVersionId: versionId, answers: { name: name('Asha'), email: { type: 'email', value: { address: 'asha@example.test' } } } });
    expect(res.statusCode).toBe(200);
    const stored = await rows(id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: res.json<{ id: string }>().id, org_id: orgId, locale: 'en-IN' });
    expect(stored[0]!.answers).toMatchObject({ name: name('Asha'), email: { type: 'email', value: { address: 'asha@example.test' } } });
    const { rows: counts } = await owner.query('select submission_count, last_submission_at from forms where id = $1', [id]);
    expect(counts[0]).toMatchObject({ submission_count: '1' });
    expect(counts[0].last_submission_at).toBeInstanceOf(Date);
  });

  it('refuses answers that break the form’s rules, with the field named, and stores nothing', async () => {
    const { id, slug, versionId } = await publish('Rules');
    const missing = await submit(slug, { formVersionId: versionId, answers: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'name', message: expect.any(String) }] });
    const wrongType = await submit(slug, { formVersionId: versionId, answers: { name: { type: 'number', value: 3 } } });
    expect(wrongType.statusCode).toBe(400);
    const badEmail = await submit(slug, { formVersionId: versionId, answers: { name: name('A'), email: { type: 'email', value: { address: 'not an address' } } } });
    expect(badEmail.statusCode).toBe(400);
    expect(badEmail.json()).toMatchObject({ errors: [{ path: expect.stringMatching(/^email(\.|$)/) }] });
    expect(await rows(id)).toEqual([]);
  });

  it('does not keep answers to fields the form does not have', async () => {
    const { id, slug, versionId } = await publish('Forged');
    const res = await submit(slug, { formVersionId: versionId, answers: { name: name('A'), bogus: name('smuggled'), ['x'.repeat(40)]: name('junk') } });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify((await rows(id))[0]!.answers)).not.toMatch(/smuggled|junk/);
  });

  it('takes answers only for the live version', async () => {
    const { id, slug, versionId } = await publish('Versions');
    const republished = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(), payload: {} });
    const next = republished.json<{ versionId: string }>().versionId;
    const stale = await submit(slug, { formVersionId: versionId, answers: { name: name('A') } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'FORM_OUTDATED' });
    expect((await submit(slug, { formVersionId: randomUUID(), answers: { name: name('A') } })).statusCode).toBe(409);
    expect(await rows(id)).toEqual([]);
    expect((await submit(slug, { formVersionId: next, answers: { name: name('A') } })).statusCode).toBe(200);
  });

  it('takes nothing for a form that is not published or no longer live', async () => {
    expect((await submit('no-such-form', { formVersionId: randomUUID(), answers: {} })).statusCode).toBe(404);
    const { id, slug, versionId } = await publish('Closing');
    expect((await submit(slug, { formVersionId: versionId, answers: { name: name('A') } })).statusCode).toBe(200);
    await owner.query(`update forms set lifecycle = 'archived' where id = $1`, [id]);
    expect((await submit(slug, { formVersionId: versionId, answers: { name: name('B') } })).statusCode).toBe(404);
    expect(await rows(id)).toHaveLength(1);
  });

  it('bounds the display rows the page sends along', async () => {
    const { slug, versionId } = await publish('Rows');
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ key: `k${i}`, label: 'L', value: 'v' }));
    expect((await submit(slug, { formVersionId: versionId, answers: { name: name('A') }, fields: tooMany })).statusCode).toBe(400);
    expect((await submit(slug, { formVersionId: versionId, answers: { name: name('A') }, fields: [{ key: 'k', label: 'L', value: 'v'.repeat(10_001) }] })).statusCode).toBe(400);
  });

  describe('files named in the answers', () => {
    const upload = async (slug: string, bytes = PDF) => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/p/${slug}/files`,
        payload: { blockId: 'cv', name: 'cv.pdf', mime: 'application/pdf', data: bytes.toString('base64') },
      });
      expect(res.statusCode).toBe(200);
      return res.json<{ fileId: string; name: string; sizeBytes: number; mime: string; sha256: string }>();
    };
    const answers = (ref: Record<string, unknown>) => ({ name: name('A'), cv: { type: 'file_upload', value: [ref] } });

    it('must have been uploaded to this form, and be the file they say', async () => {
      const a = await publish('Files A');
      const b = await publish('Files B');
      const mine = await upload(a.slug);
      const theirs = await upload(b.slug);

      const ok = await submit(a.slug, { formVersionId: a.versionId, answers: answers({ ...mine, scan: 'skipped' }) });
      expect(ok.statusCode).toBe(200);

      const unknown = await submit(a.slug, { formVersionId: a.versionId, answers: answers({ ...mine, fileId: randomUUID() }) });
      expect(unknown.statusCode).toBe(400);
      const foreign = await submit(a.slug, { formVersionId: a.versionId, answers: answers({ ...theirs }) });
      expect(foreign.statusCode).toBe(400);
      const forgedHash = await submit(a.slug, { formVersionId: a.versionId, answers: answers({ ...mine, sha256: 'f'.repeat(64) }) });
      expect(forgedHash.statusCode).toBe(400);
      const forgedSize = await submit(a.slug, { formVersionId: a.versionId, answers: answers({ ...mine, sizeBytes: 5 }) });
      expect(forgedSize.statusCode).toBe(400);
      expect(await rows(a.id)).toHaveLength(1);
    });

    it('may be opened by a member of the form’s org, and only through the org route', async () => {
      const a = await publish('Files C');
      const file = await upload(a.slug);
      await submit(a.slug, { formVersionId: a.versionId, answers: answers(file) });
      const opened = await app.inject({ url: `/v1/forms/${a.id}/files/${file.fileId}`, headers: as() });
      expect(opened.statusCode).toBe(200);
      expect(opened.rawPayload.equals(PDF)).toBe(true);
      expect((await app.inject({ url: `/v1/forms/${a.id}/files/${file.fileId}` })).statusCode).toBe(401);
    });
  });
});

describe('what is stored of the files and the rows (SR-1, SR-2)', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  type FileRef = { fileId: string; name: string; sizeBytes: number; mime: string; sha256: string; scan: string };
  const send = async (slug: string, blockId: string, body: Record<string, unknown>) => {
    const res = await app.inject({ method: 'POST', url: `/v1/p/${slug}/files`, payload: { blockId, ...body } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<FileRef>();
  };
  const cv = (slug: string, bytes = PDF) => send(slug, 'cv', { name: 'cv.pdf', mime: 'application/pdf', data: bytes.toString('base64') });
  const sig = (slug: string) => send(slug, 'sig', { purpose: 'signature', name: 'signature.png', mime: 'image/png', data: PNG.toString('base64') });
  const signature = (file: Record<string, unknown>) => ({ type: 'signature', value: { method: 'drawn', file } });

  async function publishSigned(title: string): Promise<{ id: string; slug: string; versionId: string }> {
    const blocks = [...FIELDS(), fieldBlock('sig', 'signature')];
    const { id } = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(), payload: { title } })).json<{ id: string }>();
    expect((await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: as(), payload: { draft: draftWith(id, blocks, title) } })).statusCode).toBe(200);
    const live = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(), payload: {} });
    expect(live.statusCode).toBe(200);
    return { id, ...live.json<{ slug: string; versionId: string }>() };
  }

  it('rewrites every file reference from the upload row: name, type and scan state are the stored ones', async () => {
    const f = await publishSigned('Rewrite');
    const file = await cv(f.slug);
    const res = await submit(f.slug, {
      formVersionId: f.versionId,
      answers: { name: name('A'), cv: { type: 'file_upload', value: [{ ...file, name: 'renamed.pdf', scan: 'clean' }] } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const stored = (await rows(f.id))[0]!.answers as { cv: { value: FileRef[] } };
    expect(stored.cv.value).toEqual([{ fileId: file.fileId, name: 'cv.pdf', sizeBytes: PDF.length, mime: 'application/pdf', sha256: file.sha256, scan: 'skipped' }]);
  });

  it('keeps a signature’s file bound to the signature field, and a document’s to its own', async () => {
    const f = await publishSigned('Kinds');
    const doc = await cv(f.slug);
    const drawn = await sig(f.slug);
    // A document named as the signature, and the signature named as a document.
    const asSignature = await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('A'), sig: signature(doc) } });
    expect(asSignature.statusCode).toBe(400);
    const asDocument = await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('A'), cv: { type: 'file_upload', value: [drawn] } } });
    expect(asDocument.statusCode).toBe(400);
    expect(await rows(f.id)).toEqual([]);
    const ok = await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('A'), cv: { type: 'file_upload', value: [doc] }, sig: signature({ ...drawn, name: 'my-signature.exe' }) } });
    expect(ok.statusCode, ok.body).toBe(200);
    const stored = (await rows(f.id))[0]!.answers as { sig: { value: { file: FileRef } } };
    expect(stored.sig.value.file).toMatchObject({ fileId: drawn.fileId, name: 'signature.png', mime: 'image/png', scan: 'skipped' });
  });

  it('refuses a file named in a field that takes no file', async () => {
    const f = await publishSigned('Smuggled');
    const doc = await cv(f.slug);
    const res = await submit(f.slug, { formVersionId: f.versionId, answers: { name: { type: 'short_text', value: { fileId: doc.fileId } } } });
    expect(res.statusCode).toBe(400);
    expect(await rows(f.id)).toEqual([]);
  });

  it('holds the files a stored submission names, so only unreferenced uploads are left for the orphan sweep', async () => {
    const f = await publishSigned('Holds');
    const used = await cv(f.slug);
    const stray = await cv(f.slug, Buffer.concat([PDF, Buffer.from('% another\n')]));
    const res = await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('A'), cv: { type: 'file_upload', value: [used] } } });
    expect(res.statusCode).toBe(200);
    const held = await owner.query<{ id: string; submission_id: string | null }>('select id, submission_id from form_files where form_id = $1 order by created_at', [f.id]);
    expect(Object.fromEntries(held.rows.map((r) => [r.id, r.submission_id]))).toEqual({ [used.fileId]: res.json<{ id: string }>().id, [stray.fileId]: null });
  });

  it('refuses text the database cannot store and a language the form does not offer, storing nothing', async () => {
    const f = await publishSigned('Text');
    expect((await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('a\u0000b') } })).statusCode).toBe(400);
    expect((await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('lone \ud800 surrogate') } })).statusCode).toBe(400);
    const language = await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('A') }, locale: 'fr-FR' });
    expect(language.statusCode).toBe(400);
    expect(language.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'locale' }] });
    expect(await rows(f.id)).toEqual([]);
    expect((await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('A') }, locale: 'en-IN' })).statusCode).toBe(200);
  });
});
