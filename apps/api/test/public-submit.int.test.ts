import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, provision, submissions, uuidV7Time, withTenant, type DbHandle } from '@form/db';
import { DEFAULT_COMPLIANCE } from '@form/registry';
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
let appDb: DbHandle;
let dir: string;
let orgId: string;
let userId: string;
/** Moves the app's clock forward (milliseconds) so a test can put a second between two events without sleeping. */
let skewMs = 0;

const as = () => ({ 'x-fr-dev-user': userId, 'x-fr-org': orgId, ...BROWSER });
const name = (value: string) => ({ type: 'short_text', value });

const FIELDS = () => [
  fieldBlock('name', 'short_text', {}, { required: true }),
  fieldBlock('email', 'email'),
  fieldBlock('cv', 'file_upload', { accept: { extensions: ['pdf'], mimeTypes: ['application/pdf'] } }),
];

async function publishBlocks(title: string, blocks: Array<ReturnType<typeof fieldBlock>>, rules: unknown[] = []): Promise<{ id: string; slug: string; versionId: string }> {
  const { id } = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(), payload: { title } })).json<{ id: string }>();
  const draft = draftWith(id, blocks, title);
  const withRules = { ...draft, logic: { ...draft.logic, rules } };
  const put = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...as(), 'if-match': '0' }, payload: { draft: withRules } });
  expect(put.statusCode, put.body).toBe(200);
  const live = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(), payload: {} });
  expect(live.statusCode, live.body).toBe(200);
  return { id, ...live.json<{ slug: string; versionId: string }>() };
}

const publish = (title: string) => publishBlocks(title, FIELDS());

/** Saves the form's access settings (the ones in `patch` over the defaults), reading the revision first. */
async function setAccess(formId: string, patch: Record<string, unknown>): Promise<void> {
  const current = await app.inject({ url: `/v1/forms/${formId}/access`, headers: as() });
  const res = await app.inject({
    method: 'PUT',
    url: `/v1/forms/${formId}/access`,
    headers: { ...as(), 'if-match': String(current.json<{ rev: number }>().rev) },
    payload: { enabled: true, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72, ...patch },
  });
  expect(res.statusCode, res.body).toBe(200);
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_submit');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  appDb = createDb(urls.fr_app, { max: 2, applicationName: 'fr-api-submit-test' });
  dir = await mkdtemp(path.join(tmpdir(), 'fr-submit-'));
  orgId = randomUUID();
  userId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'submit']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@submit.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);
  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  app = await buildApp(parsed.config, { underPressure: false, files: createFileStore(dir), now: () => new Date(Date.now() + skewMs) });
});

afterAll(async () => {
  await app?.close();
  await appDb?.close();
  await owner?.end();
  await rm(dir, { recursive: true, force: true });
});

/** A respondent's POST. Each call is a new submission (a fresh Idempotency-Key) unless `headers` says otherwise. */
const submit = (slug: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `/v1/p/${slug}/submissions`, headers: { 'idempotency-key': randomUUID(), ...headers }, payload: { locale: 'en-IN', fields: [], ...body } });

async function rows(formId: string): Promise<Array<{ id: string; org_id: string; answers: Record<string, unknown>; locale: string }>> {
  return (await owner.query(`select id, org_id, answers, meta->>'locale' as locale from submissions where form_id = $1 order by seq`, [formId])).rows;
}

const submittedTotal = async (formId: string): Promise<number> => Number((await owner.query('select submitted_total from form_counters where form_id = $1', [formId])).rows[0].submitted_total);

/** The runtime GET of a form, as a respondent makes it (no session). */
const view = (slug: string, headers: Record<string, string> = {}) => app.inject({ url: `/v1/p/${slug}`, headers });

/** What a member sees of one stored response: the display rows rebuilt from its answers and its version's labels. */
async function shown(formId: string, submissionId: string): Promise<{ fields: Array<{ key: string; label: string; value: string }>; locale: string }> {
  const res = await app.inject({ url: `/v1/forms/${formId}/submissions/${submissionId}`, headers: as() });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
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
    expect(stored[0]).toMatchObject({ id: res.json<{ submissionId: string }>().submissionId, org_id: orgId, locale: 'en-IN' });
    expect(stored[0]!.answers).toMatchObject({ name: name('Asha'), email: { type: 'email', value: { address: 'asha@example.test' } } });
    const { rows: counts } = await owner.query('select submission_count, last_submission_at from forms where id = $1', [id]);
    expect(counts[0]).toMatchObject({ submission_count: '1' });
    expect(counts[0].last_submission_at).toBeInstanceOf(Date);
  });

  it('files the response under the live version it was validated against, with the version’s hash and a server-made UUIDv7', async () => {
    const { id, slug, versionId } = await publish('Filed');
    const before = Date.now();
    const res = await submit(slug, { formVersionId: versionId, answers: { name: name('Asha') }, locale: 'en-IN' });
    expect(res.statusCode).toBe(200);
    const submissionId = res.json<{ submissionId: string }>().submissionId;
    const { rows } = await owner.query(
      `select s.id, s.received_at, s.org_id, s.form_id, s.form_version_id, encode(s.definition_hash, 'hex') as hash, v.content_hash, s.answer_codec_version, s.status,
              s.computed, s.meta, s.revision, s.read, s.legal_hold, s.trashed_at, s.seq::int as seq,
              s.delete_after = ((s.received_at at time zone 'UTC') + interval '10 years') at time zone 'UTC' as retention_placeholder
       from submissions s join form_versions v on v.id = s.form_version_id where s.form_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      id: submissionId,
      org_id: orgId,
      form_id: id,
      form_version_id: versionId,
      answer_codec_version: 0,
      status: 'complete',
      computed: {},
      meta: { locale: 'en-IN' },
      revision: 1,
      read: false,
      legal_hold: false,
      trashed_at: null,
      retention_placeholder: true,
    });
    expect(row.hash).toBe(row.content_hash);
    expect(row.seq).toBeGreaterThan(0);
    // The id is a UUIDv7 and received_at is the moment inside it, which is when the server took the answers.
    expect(uuidV7Time(submissionId)?.getTime()).toBe(row.received_at.getTime());
    expect(row.received_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.received_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('never takes the id, the moment or any stored column from the page', async () => {
    const { id, slug, versionId } = await publish('Forged ids');
    const forged = '018f0000-0000-7000-8000-000000000001';
    const res = await submit(slug, {
      formVersionId: versionId,
      answers: { name: name('A') },
      id: forged,
      receivedAt: '2001-01-01T00:00:00Z',
      orgId: randomUUID(),
      status: 'spam',
      deleteAfter: '2001-01-01T00:00:00Z',
      legalHold: true,
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await owner.query('select id, received_at, org_id, status, legal_hold, delete_after > now() as in_future from submissions where form_id = $1', [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: orgId, status: 'complete', legal_hold: false, in_future: true });
    expect(rows[0].id).not.toBe(forged);
    expect(rows[0].received_at.getTime()).toBeGreaterThan(Date.UTC(2026, 0, 1));
  });

  it('refuses answers that break the form’s rules, with the field named, and stores nothing', async () => {
    const { id, slug, versionId } = await publish('Rules');
    const missing = await submit(slug, { formVersionId: versionId, answers: {} });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ code: 'SUBMISSION_INVALID', errors: [{ path: 'name', message: expect.any(String) }] });
    const wrongType = await submit(slug, { formVersionId: versionId, answers: { name: { type: 'number', value: 3 } } });
    expect(wrongType.statusCode).toBe(422);
    const badEmail = await submit(slug, { formVersionId: versionId, answers: { name: name('A'), email: { type: 'email', value: { address: 'not an address' } } } });
    expect(badEmail.statusCode).toBe(422);
    expect(badEmail.json()).toMatchObject({ errors: [{ path: expect.stringMatching(/^email(\.|$)/) }] });
    expect(await rows(id)).toEqual([]);
  });

  it('does not keep answers to fields the form does not have', async () => {
    const { id, slug, versionId } = await publish('Forged');
    const res = await submit(slug, { formVersionId: versionId, answers: { name: name('A'), bogus: name('smuggled'), ['x'.repeat(40)]: name('junk') } });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify((await rows(id))[0]!.answers)).not.toMatch(/smuggled|junk/);
  });

  it('takes answers for the live version, and for the one it replaced while the form still accepts it (frozen time is in submit-limits)', async () => {
    const { id, slug, versionId } = await publish('Versions');
    const republished = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(), payload: {} });
    const next = republished.json<{ versionId: string }>().versionId;
    // The default is 72 hours after the newer version went live: a page opened before the republish still submits.
    const grace = await submit(slug, { formVersionId: versionId, answers: { name: name('A') } });
    expect(grace.statusCode, grace.body).toBe(200);
    const { rows: filed } = await owner.query<{ form_version_id: string; meta: { versionNumber: number } }>('select form_version_id, meta from submissions where form_id = $1', [id]);
    expect(filed).toEqual([{ form_version_id: versionId, meta: expect.objectContaining({ versionNumber: 1 }) }]);
    // A form that accepts no previous version refuses it at once, with a code the page can act on.
    await setAccess(id, { acceptPreviousVersionsHours: 0 });
    const stale = await submit(slug, { formVersionId: versionId, answers: { name: name('A') } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_SUPERSEDED' });
    expect((await submit(slug, { formVersionId: randomUUID(), answers: { name: name('A') } })).statusCode).toBe(409);
    expect(await rows(id)).toHaveLength(1);
    const live = await submit(slug, { formVersionId: next, answers: { name: name('A') } });
    expect(live.statusCode).toBe(200);
    expect((await owner.query<{ meta: { versionNumber: number } }>('select meta from submissions where id = $1', [live.json<{ submissionId: string }>().submissionId])).rows[0]!.meta.versionNumber).toBe(2);
  });

  it('does not take the version of another form, whoever owns it', async () => {
    const a = await publish('Own version A');
    const b = await publish('Own version B');
    const res = await submit(a.slug, { formVersionId: b.versionId, answers: { name: name('A') } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'VERSION_SUPERSEDED' });
    expect(await rows(a.id)).toEqual([]);
    expect(await rows(b.id)).toEqual([]);
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
      expect(unknown.statusCode).toBe(422);
      const foreign = await submit(a.slug, { formVersionId: a.versionId, answers: answers({ ...theirs }) });
      expect(foreign.statusCode).toBe(422);
      const forgedHash = await submit(a.slug, { formVersionId: a.versionId, answers: answers({ ...mine, sha256: 'f'.repeat(64) }) });
      expect(forgedHash.statusCode).toBe(422);
      const forgedSize = await submit(a.slug, { formVersionId: a.versionId, answers: answers({ ...mine, sizeBytes: 5 }) });
      expect(forgedSize.statusCode).toBe(422);
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
    expect((await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...as(), 'if-match': '0' }, payload: { draft: draftWith(id, blocks, title) } })).statusCode).toBe(200);
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
    expect(asSignature.statusCode).toBe(422);
    const asDocument = await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('A'), cv: { type: 'file_upload', value: [drawn] } } });
    expect(asDocument.statusCode).toBe(422);
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
    expect(res.statusCode).toBe(422);
    expect(await rows(f.id)).toEqual([]);
  });

  it('holds the files a stored submission names, so only unreferenced uploads are left for the orphan sweep', async () => {
    const f = await publishSigned('Holds');
    const used = await cv(f.slug);
    const stray = await cv(f.slug, Buffer.concat([PDF, Buffer.from('% another\n')]));
    const res = await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('A'), cv: { type: 'file_upload', value: [used] } } });
    expect(res.statusCode).toBe(200);
    const held = await owner.query<{ id: string; submission_id: string | null; submission_received_at: Date | null }>(
      'select id, submission_id, submission_received_at from form_files where form_id = $1 order by created_at',
      [f.id],
    );
    expect(Object.fromEntries(held.rows.map((r) => [r.id, r.submission_id]))).toEqual({ [used.fileId]: res.json<{ submissionId: string }>().submissionId, [stray.fileId]: null });
    // A file is held by the whole key of the partitioned row: its id and the moment it was received.
    const [stored] = await rows(f.id);
    const { rows: moments } = await owner.query<{ received_at: Date }>('select received_at from submissions where id = $1', [stored!.id]);
    expect(Object.fromEntries(held.rows.map((r) => [r.id, r.submission_received_at?.getTime() ?? null]))).toEqual({
      [used.fileId]: moments[0]!.received_at.getTime(),
      [stray.fileId]: null,
    });
  });

  it('shows display rows built from the validated answers and the form’s own labels, never the page’s', async () => {
    const f = await publishSigned('Rows server');
    const file = await cv(f.slug);
    const forged = [{ key: 'approval', label: 'Approved by HR', value: 'Yes - pay in full' }, { key: 'name', label: 'Name', value: 'Somebody else' }];
    const res = await submit(f.slug, {
      formVersionId: f.versionId,
      answers: { name: name('Asha'), email: { type: 'email', value: { address: 'asha@example.test' } }, cv: { type: 'file_upload', value: [{ ...file, name: 'forged.pdf' }] } },
      fields: forged,
    });
    expect(res.statusCode, res.body).toBe(200);
    const stored = [await shown(f.id, res.json<{ submissionId: string }>().submissionId)];
    expect(stored[0]!.fields).toEqual([
      { key: 'name', label: 'name', value: 'Asha' },
      { key: 'email', label: 'email', value: 'asha@example.test' },
      { key: 'cv', label: 'cv', value: 'cv.pdf' },
    ]);
    expect(JSON.stringify(stored[0]!.fields)).not.toMatch(/Approved by HR|Somebody else|forged/);
    // No answers, no rows: a response cannot show a line the form never asked.
    const empty = await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('B') }, fields: forged });
    const only = [await shown(f.id, empty.json<{ submissionId: string }>().submissionId)];
    expect(only[0]!.fields).toEqual([{ key: 'name', label: 'name', value: 'B' }]);
  });

  it('refuses text the database cannot store and a language the form does not offer, storing nothing', async () => {
    const f = await publishSigned('Text');
    expect((await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('a\u0000b') } })).statusCode).toBe(400);
    expect((await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('lone \ud800 surrogate') } })).statusCode).toBe(400);
    const language = await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('A') }, locale: 'fr-FR' });
    expect(language.statusCode).toBe(422);
    expect(language.json()).toMatchObject({ code: 'SUBMISSION_INVALID', errors: [{ path: 'locale' }] });
    expect(await rows(f.id)).toEqual([]);
    expect((await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('A') }, locale: 'en-IN' })).statusCode).toBe(200);
  });
});

/** A `hidden` block that captures the URL parameter named like its key; the block of FLD-30. */
const hiddenBlock = (id: string) =>
  ({ ...fieldBlock(id, 'short_text'), type: 'hidden', config: { source: { kind: 'url_param' } }, compliance: { ...DEFAULT_COMPLIANCE.hidden, purposeIds: [] } }) as unknown as ReturnType<typeof fieldBlock>;

/** A rule that hides `target` while `watched` has an answer: the conditionally hidden field. */
const hideWhenAnswered = (watched: string, target: string) => ({
  id: 'rule_hide',
  enabled: true,
  when: { kind: 'group', id: 'group_hide', combinator: 'all', children: [{ kind: 'condition', id: 'cond_hide', left: { kind: 'ref', ref: { kind: 'answer', blockId: watched } }, op: 'is_answered' }] },
  then: [{ type: 'hide', targets: [target] }],
});

describe('what is stored of the answers (WP-1.12, LOG-25)', () => {
  const blocks = () => [fieldBlock('name', 'short_text', {}, { required: true }), fieldBlock('promo', 'short_text'), fieldBlock('code', 'short_text'), hiddenBlock('source')];
  const hidden = (value: string) => ({ type: 'hidden', value });

  it('drops the answer to a field a rule hides, and to a hidden block the page address did not set', async () => {
    const f = await publishBlocks('Hidden answers', blocks(), [hideWhenAnswered('promo', 'code')]);
    const res = await submit(f.slug, {
      formVersionId: f.versionId,
      answers: { name: name('Asha'), promo: name('SAVE10'), code: name('only-for-people-without-a-promo'), source: hidden('forged-by-the-page') },
    });
    expect(res.statusCode, res.body).toBe(200);
    const stored = (await rows(f.id))[0]!.answers;
    expect(stored).toEqual({ name: name('Asha'), promo: name('SAVE10') });
    expect(JSON.stringify(stored)).not.toMatch(/only-for-people|forged-by-the-page/);
  });

  it('keeps the answer to the same field while no rule hides it', async () => {
    const f = await publishBlocks('Shown answers', blocks(), [hideWhenAnswered('promo', 'code')]);
    const res = await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('Asha'), code: name('visible-code') } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await rows(f.id))[0]!.answers).toEqual({ name: name('Asha'), code: name('visible-code') });
  });

  it('fills a hidden block from the page address the browser reported, and never from the answers it sent', async () => {
    const f = await publishBlocks('Captured', blocks());
    const res = await submit(f.slug, {
      formVersionId: f.versionId,
      answers: { name: name('Asha'), source: hidden('forged-by-the-page') },
      client: { urlParams: { source: 'newsletter-7' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await rows(f.id))[0]!.answers).toEqual({ name: name('Asha'), source: hidden('newsletter-7') });
  });

  it('records how the response was made: language, address without its query, referrer host, device, times and the version number', async () => {
    const f = await publish('Meta');
    const startedAt = new Date(Date.now() - 4000).toISOString();
    const res = await submit(f.slug, {
      formVersionId: f.versionId,
      answers: { name: name('Asha') },
      client: { startedAt, pageUrl: 'https://forms.example/f/meta?utm_source=news&email=asha%40example.test', referrer: 'https://news.example/post/1?token=secret', device: 'tablet', timeZone: 'Asia/Kolkata' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { rows: stored } = await owner.query<{ meta: Record<string, unknown>; computed: Record<string, unknown> }>('select meta, computed from submissions where form_id = $1', [f.id]);
    expect(stored[0]!.meta).toMatchObject({ locale: 'en-IN', pageUrl: 'https://forms.example/f/meta', referrer: 'news.example', device: 'tablet', startedAt, versionNumber: 1 });
    expect(stored[0]!.meta['durationMs']).toBeGreaterThanOrEqual(4000);
    expect(stored[0]!.meta['durationMs']).toBeLessThan(60_000);
    expect(JSON.stringify(stored[0]!.meta)).not.toMatch(/utm_source|asha|token|secret/);
    // What the answers reached, for whoever reads the response later; never a variable (those can be tainted).
    expect(stored[0]!.computed).toEqual({ path: ['page_1'], endingId: 'end_1' });
    expect(res.json()).toEqual({ ok: true, submissionId: expect.any(String), endingId: 'end_1' });
  });

  it('refuses a body with no Idempotency-Key, or one that is not a single uuid, and stores nothing', async () => {
    const f = await publish('Keys');
    const body = { formVersionId: f.versionId, answers: { name: name('A') } };
    const send = (headers: Record<string, string>) => app.inject({ method: 'POST', url: `/v1/p/${f.slug}/submissions`, headers, payload: { locale: 'en-IN', fields: [], ...body } });
    for (const headers of [{}, { 'idempotency-key': '' }, { 'idempotency-key': 'not-a-uuid' }, { 'idempotency-key': `${randomUUID()}, ${randomUUID()}` }]) {
      const res = await send(headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'headers.idempotency-key' }] });
    }
    expect(await rows(f.id)).toEqual([]);
    // An upper-case uuid is the same key as its lower-case spelling.
    const key = randomUUID();
    expect((await send({ 'idempotency-key': key.toUpperCase() })).statusCode).toBe(200);
    expect((await send({ 'idempotency-key': key })).headers['idempotent-replayed']).toBe('true');
    expect(await rows(f.id)).toHaveLength(1);
  });
});

describe('idempotent submits (WP-1.12, SUB-01)', () => {
  it('gives a retry the first result, counts it once and says it is a replay; other answers under the same key are refused', async () => {
    const f = await publish('Idempotent');
    const key = randomUUID();
    const body = { formVersionId: f.versionId, answers: { name: name('Asha') } };
    const before = await submittedTotal(f.id);
    const first = await submit(f.slug, body, { 'idempotency-key': key });
    const second = await submit(f.slug, body, { 'idempotency-key': key });
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await rows(f.id)).toHaveLength(1);
    expect(await submittedTotal(f.id)).toBe(before + 1);
    expect(Number((await owner.query('select submission_count from forms where id = $1', [f.id])).rows[0].submission_count)).toBe(1);
    expect((await owner.query('select count(*)::int as n from submission_idempotency where form_id = $1', [f.id])).rows[0].n).toBe(1);

    const other = await submit(f.slug, { ...body, answers: { name: name('Ravi') } }, { 'idempotency-key': key });
    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(await rows(f.id)).toHaveLength(1);
    expect(await submittedTotal(f.id)).toBe(before + 1);
    // The stored result holds ids only, never an answer.
    const { rows: kept } = await owner.query<{ response: Record<string, unknown> }>('select response from submission_idempotency where form_id = $1', [f.id]);
    expect(Object.keys(kept[0]!.response).sort()).toEqual(['endingId', 'submissionId']);
    expect(JSON.stringify(kept[0]!.response)).not.toContain('Asha');
  });

  it('keys are per form: the same key on two forms is two submissions', async () => {
    const a = await publish('Idempotent A');
    const b = await publish('Idempotent B');
    const key = randomUUID();
    expect((await submit(a.slug, { formVersionId: a.versionId, answers: { name: name('A') } }, { 'idempotency-key': key })).statusCode).toBe(200);
    const onB = await submit(b.slug, { formVersionId: b.versionId, answers: { name: name('A') } }, { 'idempotency-key': key });
    expect(onB.statusCode).toBe(200);
    expect(onB.headers['idempotent-replayed']).toBeUndefined();
    expect(await rows(a.id)).toHaveLength(1);
    expect(await rows(b.id)).toHaveLength(1);
  });

  it('stores one response when the same request arrives several times at once', async () => {
    const f = await publish('Idempotent race');
    const key = randomUUID();
    const body = { formVersionId: f.versionId, answers: { name: name('Asha') } };
    const before = await submittedTotal(f.id);
    const all = await Promise.all(Array.from({ length: 8 }, () => submit(f.slug, body, { 'idempotency-key': key })));
    expect(all.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    expect(new Set(all.map((r) => r.json<{ submissionId: string }>().submissionId)).size).toBe(1);
    expect(all.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(7);
    expect(await rows(f.id)).toHaveLength(1);
    expect(await submittedTotal(f.id)).toBe(before + 1);
  });

  it('gives the retry of the last response a limit allows its result, not LIMIT_REACHED', async () => {
    const f = await publish('Idempotent last');
    await setAccess(f.id, { submissionLimit: 1 });
    const key = randomUUID();
    const body = { formVersionId: f.versionId, answers: { name: name('Asha') } };
    const first = await submit(f.slug, body, { 'idempotency-key': key });
    expect(first.statusCode).toBe(200);
    const retry = await submit(f.slug, body, { 'idempotency-key': key });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    const next = await submit(f.slug, body);
    expect(next.statusCode).toBe(409);
    expect(next.json()).toMatchObject({ code: 'LIMIT_REACHED' });
    expect(await rows(f.id)).toHaveLength(1);
  });

  it('does not keep the key of a request that was refused, so the corrected request goes through', async () => {
    const f = await publish('Idempotent refused');
    const key = randomUUID();
    const bad = await submit(f.slug, { formVersionId: f.versionId, answers: {} }, { 'idempotency-key': key });
    expect(bad.statusCode).toBe(422);
    const fixed = await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('Asha') } }, { 'idempotency-key': key });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(fixed.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('who reads a response (SR-5, WP-1.12)', () => {
  it('lets a respondent context read the responses its verified token names and no other, and an anonymous one none', async () => {
    const f = await publish('Own rows');
    const mine = (await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('Mine') } })).json<{ submissionId: string }>().submissionId;
    const theirs = (await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('Theirs') } })).json<{ submissionId: string }>().submissionId;
    const read = (ctx: { orgId?: string; subjectIds?: string[] }) =>
      withTenant(appDb.db, { orgId: ctx.orgId ?? orgId, actor: 'respondent', requestId: 'own-rows', readOnly: true, ...(ctx.subjectIds ? { subjectIds: ctx.subjectIds } : {}) }, (tx) =>
        tx.select({ id: submissions.id }).from(submissions),
      );
    expect((await read({ subjectIds: [mine] })).map((r) => r.id)).toEqual([mine]);
    expect((await read({ subjectIds: [theirs] })).map((r) => r.id)).toEqual([theirs]);
    expect(await read({})).toEqual([]);
    expect(await read({ subjectIds: [randomUUID()] })).toEqual([]);
    // The same token in another org's context names nothing there.
    expect(await read({ orgId: randomUUID(), subjectIds: [mine] })).toEqual([]);
  });
});

describe('what a form may do now (WP-1.07 status, enforced at receivedAt)', () => {
  const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

  it('refuses a form that is switched off, past its close date or before its open date, and shows the page why', async () => {
    const f = await publish('Closed');
    const body = { formVersionId: f.versionId, answers: { name: name('A') } };
    await setAccess(f.id, { enabled: false, screens: { closed: { content: doc('We are closed') } } });
    const off = await submit(f.slug, body);
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ code: 'FORM_CLOSED' });
    const page = await view(f.slug);
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ slug: f.slug, status: { state: 'closed', screen: doc('We are closed') }, version: { versionId: f.versionId, status: { state: 'closed' } } });
    expect(page.headers['cache-control']).toBe('no-store');

    await setAccess(f.id, { closeAt: new Date(Date.now() - 60_000).toISOString(), openAt: new Date(Date.now() - 3_600_000).toISOString() });
    expect((await submit(f.slug, body)).json()).toMatchObject({ code: 'FORM_CLOSED' });
    await setAccess(f.id, { openAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await submit(f.slug, body)).json()).toMatchObject({ code: 'FORM_CLOSED' });
    expect((await view(f.slug)).json()).toMatchObject({ status: { state: 'not_yet_open' } });
    expect(await rows(f.id)).toEqual([]);

    await setAccess(f.id, {});
    expect((await submit(f.slug, body)).statusCode).toBe(200);
    expect((await view(f.slug)).json()).toMatchObject({ status: { state: 'open' } });
  });

  it('refuses a form that has taken its limit, by the status and by the counter', async () => {
    const f = await publish('Full');
    await setAccess(f.id, { submissionLimit: 2 });
    const body = { formVersionId: f.versionId, answers: { name: name('A') } };
    expect((await submit(f.slug, body)).statusCode).toBe(200);
    expect((await view(f.slug)).json()).toMatchObject({ status: { state: 'open' } });
    expect((await submit(f.slug, body)).statusCode).toBe(200);
    const over = await submit(f.slug, body);
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ code: 'LIMIT_REACHED' });
    expect((await view(f.slug)).json()).toMatchObject({ status: { state: 'limit_reached' } });
    expect(await rows(f.id)).toHaveLength(2);
    expect(await submittedTotal(f.id)).toBe(2);
  });

  describe('a password form', () => {
    const PASSWORD = 'violet-anchor-teapot-91';

    async function protectedForm(title: string) {
      const f = await publish(title);
      const set = await app.inject({ method: 'PUT', url: `/v1/forms/${f.id}/access/password`, headers: as(), payload: { password: PASSWORD } });
      expect(set.statusCode, set.body).toBe(200);
      return f;
    }
    const unlock = async (slug: string, password = PASSWORD, remoteAddress = '198.51.100.21'): Promise<string> => {
      const res = await app.inject({ method: 'POST', url: `/v1/p/${slug}/unlock`, remoteAddress, payload: { password } });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ accessToken: string }>().accessToken;
    };

    it('withholds the definition until the access token is sent, and takes no answers without it', async () => {
      const f = await protectedForm('Protected');
      const locked = await view(f.slug);
      expect(locked.statusCode).toBe(200);
      expect(locked.json()).toMatchObject({ slug: f.slug, formId: f.id, status: { state: 'password' } });
      expect(locked.json()).not.toHaveProperty('version');
      expect(locked.body).not.toMatch(/"blocks"|"definition"|"compiled"|"pages"/);
      const garbage = await view(f.slug, { 'x-fr-access': 'fr1.AAAA.BBBB' });
      expect(garbage.json()).not.toHaveProperty('version');

      const body = { formVersionId: f.versionId, answers: { name: name('A') } };
      for (const headers of [{}, { 'x-fr-access': 'fr1.AAAA.BBBB' }]) {
        const refused = await submit(f.slug, body, headers);
        expect(refused.statusCode).toBe(401);
        expect(refused.json()).toMatchObject({ code: 'PASSWORD_REQUIRED' });
      }
      expect(await rows(f.id)).toEqual([]);

      const token = await unlock(f.slug);
      const open = await view(f.slug, { 'x-fr-access': token });
      expect(open.json()).toMatchObject({ status: { state: 'open' }, version: { versionId: f.versionId, status: { state: 'open' }, definition: { formId: f.id } } });
      const taken = await submit(f.slug, body, { 'x-fr-access': token });
      expect(taken.statusCode, taken.body).toBe(200);
      expect(await rows(f.id)).toHaveLength(1);
    });

    it('withholds the definition whatever the status: a password form that is off, closed, not yet open or full still hides its questions', async () => {
      const f = await protectedForm('Protected, not open');
      const token = await unlock(f.slug, PASSWORD, '198.51.100.22');
      const body = { formVersionId: f.versionId, answers: { name: name('A') } };
      const hidden = async (state: string) => {
        const page = await view(f.slug);
        expect(page.statusCode, page.body).toBe(200);
        expect(page.json(), state).toMatchObject({ slug: f.slug, formId: f.id, status: { state } });
        expect(page.json(), state).not.toHaveProperty('version');
        expect(page.json(), state).not.toHaveProperty('media');
        expect(page.body, state).not.toMatch(/"blocks"|"definition"|"compiled"|"pages"|"rules"/);
        // A wrong token is no better than none.
        expect((await view(f.slug, { 'x-fr-access': 'fr1.AAAA.BBBB' })).json(), state).not.toHaveProperty('version');
      };

      await setAccess(f.id, { enabled: false });
      await hidden('closed');
      await setAccess(f.id, { openAt: new Date(Date.now() - 3_600_000).toISOString(), closeAt: new Date(Date.now() - 60_000).toISOString() });
      await hidden('closed');
      await setAccess(f.id, { openAt: new Date(Date.now() + 3_600_000).toISOString() });
      await hidden('not_yet_open');

      // Whoever holds the password sees the questions with the status, as for any other form.
      const unlocked = await view(f.slug, { 'x-fr-access': token });
      expect(unlocked.json()).toMatchObject({ status: { state: 'not_yet_open' }, version: { versionId: f.versionId, status: { state: 'not_yet_open' }, definition: { formId: f.id } } });

      await setAccess(f.id, { submissionLimit: 1 });
      expect((await submit(f.slug, body, { 'x-fr-access': token })).statusCode).toBe(200);
      await hidden('limit_reached');
      expect(await rows(f.id)).toHaveLength(1);
    });

    it('stops honouring a token once the password is changed, for the definition and for answers', async () => {
      const f = await protectedForm('Protected, rotated');
      const body = { formVersionId: f.versionId, answers: { name: name('A') } };
      const old = await unlock(f.slug, PASSWORD, '198.51.100.23');
      expect((await view(f.slug, { 'x-fr-access': old })).json()).toHaveProperty('version');

      // A second later (the token says when it was issued in whole seconds) the owner rotates the leaked password.
      skewMs += 3_000;
      try {
        const next = 'copper-lantern-orbit-47';
        const set = await app.inject({ method: 'PUT', url: `/v1/forms/${f.id}/access/password`, headers: as(), payload: { password: next } });
        expect(set.statusCode, set.body).toBe(200);

        const page = await view(f.slug, { 'x-fr-access': old });
        expect(page.json()).toMatchObject({ status: { state: 'password' } });
        expect(page.json()).not.toHaveProperty('version');
        expect(page.body).not.toMatch(/"blocks"|"definition"|"compiled"|"pages"/);
        const refused = await submit(f.slug, body, { 'x-fr-access': old });
        expect(refused.statusCode).toBe(401);
        expect(refused.json()).toMatchObject({ code: 'PASSWORD_REQUIRED' });
        expect(await rows(f.id)).toEqual([]);

        // The old password no longer unlocks, the new one does, and its token works.
        const stale = await app.inject({ method: 'POST', url: `/v1/p/${f.slug}/unlock`, remoteAddress: '198.51.100.23', payload: { password: PASSWORD } });
        expect(stale.statusCode).toBe(401);
        const fresh = await unlock(f.slug, next, '198.51.100.23');
        expect((await view(f.slug, { 'x-fr-access': fresh })).json()).toHaveProperty('version');
        expect((await submit(f.slug, body, { 'x-fr-access': fresh })).statusCode).toBe(200);
        expect(await rows(f.id)).toHaveLength(1);
      } finally {
        skewMs = 0;
      }
    });

    it('does not take a token made for another form, and asks again after a republish for the page of the new version', async () => {
      const f = await protectedForm('Protected A');
      const other = await protectedForm('Protected B');
      const token = await unlock(f.slug);
      const foreign = await submit(other.slug, { formVersionId: other.versionId, answers: { name: name('A') } }, { 'x-fr-access': token });
      expect(foreign.statusCode).toBe(401);
      expect((await view(other.slug, { 'x-fr-access': token })).json()).not.toHaveProperty('version');

      const republished = await app.inject({ method: 'POST', url: `/v1/forms/${f.id}/publish`, headers: as(), payload: {} });
      const next = republished.json<{ versionId: string }>().versionId;
      // The page the respondent holds is the old version's, and the token was made for it: the answers are taken...
      expect((await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('A') } }, { 'x-fr-access': token })).statusCode).toBe(200);
      // ...but it does not open the new version, whose page has to ask for the password itself.
      expect((await submit(f.slug, { formVersionId: next, answers: { name: name('B') } }, { 'x-fr-access': token })).statusCode).toBe(401);
      expect((await view(f.slug, { 'x-fr-access': token })).json()).not.toHaveProperty('version');
    });
  });

  it('answers a slug the form used to have with the current one, and still takes answers sent to the old address', async () => {
    const f = await publish('Renamed');
    const renamed = `renamed-${randomUUID().slice(0, 8)}`;
    const put = await app.inject({ method: 'PUT', url: `/v1/forms/${f.id}/slug`, headers: as(), payload: { slug: renamed } });
    expect(put.statusCode, put.body).toBe(200);
    const old = await view(f.slug);
    expect(old.statusCode).toBe(200);
    expect(old.json()).toEqual({ redirectTo: renamed });
    expect((await view(renamed)).json()).toMatchObject({ slug: renamed, formId: f.id, version: { versionId: f.versionId } });
    expect((await submit(f.slug, { formVersionId: f.versionId, answers: { name: name('A') } })).statusCode).toBe(200);
    expect(await rows(f.id)).toHaveLength(1);
    expect((await view('no-such-form-anywhere')).statusCode).toBe(404);
  });
});
