import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');

let app: FastifyInstance;
let owner: pg.Pool;
let dir: string;
let orgA: string;
let orgB: string;
let ownerA: string;
let viewerA: string;
let creatorA: string;
let ownerB: string;
let formId: string;
let slug: string;
let plainFormId: string;
let plainSlug: string;

const as = (user: string, org: string) => ({ 'x-fr-dev-user': user, 'x-fr-org': org, ...BROWSER });

async function publish(fields: Array<ReturnType<typeof fieldBlock>>, title: string): Promise<{ id: string; slug: string }> {
  const created = await app.inject({ method: 'POST', url: '/v1/forms', headers: as(ownerA, orgA), payload: { title } });
  const { id } = created.json<{ id: string }>();
  const put = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: as(ownerA, orgA), payload: { draft: draftWith(id, fields, title) } });
  expect(put.statusCode).toBe(200);
  const live = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(ownerA, orgA), payload: {} });
  expect(live.statusCode).toBe(200);
  return { id, slug: live.json<{ slug: string }>().slug };
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_files');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  dir = await mkdtemp(path.join(tmpdir(), 'fr-files-'));
  [orgA, orgB, ownerA, viewerA, creatorA, ownerB] = Array.from({ length: 6 }, () => randomUUID()) as [string, string, string, string, string, string];
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2), ($3, $4, $4)', [orgA, 'files-a', orgB, 'files-b']);
  for (const [id, who] of [[ownerA, 'owner-a'], [viewerA, 'viewer-a'], [creatorA, 'creator-a'], [ownerB, 'owner-b']] as const) {
    await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [id, `${who}@files.test`]);
  }
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3), ($1, $4, $5), ($1, $6, $7), ($8, $9, $3)', [
    orgA, ownerA, 'owner', viewerA, 'viewer', creatorA, 'creator', orgB, ownerB,
  ]);

  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  app = await buildApp(parsed.config, { underPressure: false, files: createFileStore(dir) });

  ({ id: formId, slug } = await publish(
    [
      fieldBlock('cv', 'file_upload', { maxFileBytes: 2000, accept: { extensions: ['pdf', 'png'], mimeTypes: ['application/pdf', 'image/png'] } }),
      fieldBlock('sig', 'signature'),
      fieldBlock('anything', 'file_upload', { accept: { extensions: [], mimeTypes: [] } }),
      fieldBlock('name', 'short_text'),
    ],
    'Upload form',
  ));
  ({ id: plainFormId, slug: plainSlug } = await publish([fieldBlock('name', 'short_text')], 'Plain form'));
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await rm(dir, { recursive: true, force: true });
});

const upload = (body: Record<string, unknown>, target = slug) =>
  app.inject({ method: 'POST', url: `/v1/p/${target}/files`, payload: { blockId: 'cv', name: 'cv.pdf', mime: 'application/pdf', data: b64(PDF), ...body } });

async function stored(): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe('POST /v1/p/:slug/files (respondents are anonymous)', () => {
  it('stores a file for an upload field under a server-made id and records which form owns it', async () => {
    const res = await upload({});
    expect(res.statusCode).toBe(200);
    const ref = res.json<{ fileId: string; name: string; sizeBytes: number; mime: string; sha256: string; scan: string }>();
    expect(ref).toMatchObject({ name: 'cv.pdf', sizeBytes: PDF.length, mime: 'application/pdf', scan: 'skipped' });
    expect(ref.fileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await stored()).toContain(`${ref.fileId}.bin`);
    const { rows } = await owner.query('select org_id, form_id, block_id, name, size_bytes, sha256 from form_files where id = $1', [ref.fileId]);
    expect(rows).toEqual([{ org_id: orgA, form_id: formId, block_id: 'cv', name: 'cv.pdf', size_bytes: PDF.length, sha256: ref.sha256 }]);
  });

  it('ignores an id the client chooses, so a file cannot be overwritten by id', async () => {
    const first = (await upload({ data: b64(PDF) })).json<{ fileId: string }>();
    const other = Buffer.concat([PDF, Buffer.from('% a different file\n')]);
    const second = await upload({ id: first.fileId, data: b64(other) });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ fileId: string }>().fileId).not.toBe(first.fileId);
    // The first file is as it was.
    const download = await app.inject({ url: `/v1/forms/${formId}/files/${first.fileId}`, headers: as(ownerA, orgA) });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(PDF)).toBe(true);
    // And a made-up id the client names is not created.
    const wanted = randomUUID();
    await upload({ id: wanted });
    expect(existsSync(path.join(dir, `${wanted}.bin`))).toBe(false);
  });

  it('takes files only for a field the live version has', async () => {
    expect((await upload({ blockId: 'name' })).statusCode).toBe(400);
    expect((await upload({ blockId: 'nope' })).statusCode).toBe(400);
    expect((await upload({ blockId: 'sig' })).statusCode).toBe(400);
    expect((await upload({}, plainSlug)).statusCode).toBe(400);
    expect((await upload({}, 'no-such-form')).statusCode).toBe(404);
  });

  it('stops taking files once the form is no longer live', async () => {
    const { slug: gone } = await publish([fieldBlock('cv', 'file_upload')], 'Short lived');
    expect((await upload({}, gone)).statusCode).toBe(200);
    await owner.query(`update forms set lifecycle = 'trashed' where slug = $1`, [gone]);
    expect((await upload({}, gone)).statusCode).toBe(404);
  });

  it('refuses types the field does not accept, and any markup or program, however it is named', async () => {
    const before = await stored();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['html', { name: 'page.html', mime: 'text/html', data: b64('<html><script>alert(1)</script></html>') }],
      ['svg as a png', { name: 'x.png', mime: 'image/png', data: b64('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>') }],
      ['html as a pdf', { name: 'x.pdf', mime: 'application/pdf', data: b64('<!DOCTYPE html><html><body>hi</body></html>') }],
      ['a png named .pdf', { name: 'x.pdf', mime: 'application/pdf', data: b64(PNG) }],
      ['an exe', { name: 'setup.exe', mime: 'application/octet-stream', data: b64('MZ\u0090\u0000') }],
      ['a type the field does not list', { name: 'x.txt', mime: 'text/plain', data: b64('hello') }],
      ['a pdf declared as text', { name: 'x.pdf', mime: 'text/plain', data: b64(PDF) }],
    ];
    for (const [label, body] of cases) {
      const res = await upload(body);
      expect(res.statusCode, label).toBe(415);
    }
    // A field that takes anything still refuses markup and programs, and takes a document.
    for (const body of [
      { name: 'page.html', mime: 'text/html', data: b64('<html></html>') },
      { name: 'logo.svg', mime: 'image/svg+xml', data: b64('<svg/>') },
      { name: 'run.js', mime: 'text/javascript', data: b64('alert(1)') },
      { name: 'run.sh', mime: 'text/plain', data: b64('echo hi') },
    ]) {
      expect((await upload({ blockId: 'anything', ...body })).statusCode, body.name).toBe(415);
    }
    expect((await upload({ blockId: 'anything', name: 'notes.txt', mime: 'text/plain', data: b64('plain notes') })).statusCode).toBe(200);
    // Nothing refused was kept (only the one accepted text file is new).
    expect((await stored()).length).toBe(before.length + 1);
  });

  it('refuses a file over the field’s size limit, and a body over the absolute one, before storing it', async () => {
    const before = await stored();
    const big = Buffer.concat([PDF, Buffer.alloc(2001)]);
    const over = await upload({ data: b64(big) });
    expect(over.statusCode).toBe(413);
    const huge = await upload({ blockId: 'anything', name: 'big.txt', mime: 'text/plain', data: 'A'.repeat(14 * 1024 * 1024) });
    expect(huge.statusCode).toBe(413);
    expect(await stored()).toEqual(before);
  });

  it('refuses bytes that are not base64, and an empty file', async () => {
    expect((await upload({ data: 'not base64 !!' })).statusCode).toBe(400);
    expect((await upload({ data: '' })).statusCode).toBe(400);
  });

  it('names the file safely: no path, no control or direction characters', async () => {
    const res = await upload({ name: '..\\..\\etc/passwd‮gnp.pdf' });
    expect(res.statusCode).toBe(200);
    const { name } = res.json<{ name: string }>();
    expect(name).not.toMatch(/[\\/‮]/);
    expect(name.endsWith('.pdf')).toBe(true);
    expect((await readdir(dir)).every((f) => /^[0-9a-f-]{36}\.bin$/.test(f))).toBe(true);
  });

  it('takes a signature as a PNG, for a signature field only', async () => {
    const ok = await upload({ blockId: 'sig', purpose: 'signature', name: 'signature.png', mime: 'image/png', data: b64(PNG) });
    expect(ok.statusCode).toBe(200);
    expect((await upload({ blockId: 'sig', purpose: 'signature', name: 'signature.png', mime: 'image/png', data: b64('<svg/>') })).statusCode).toBe(415);
    expect((await upload({ blockId: 'cv', purpose: 'signature', name: 'signature.png', mime: 'image/png', data: b64(PNG) })).statusCode).toBe(400);
  });

  it('has no public store any more: no client-id upload, no download by id', async () => {
    const id = randomUUID();
    const post = await app.inject({ method: 'POST', url: '/v1/p/files', payload: { id, name: 'note.txt', mime: 'text/plain', data: b64('x') } });
    expect(post.statusCode).toBe(404);
    const known = (await upload({})).json<{ fileId: string }>().fileId;
    for (const url of [`/v1/p/files/${known}`, `/v1/p/${slug}/files/${known}`]) {
      expect((await app.inject({ url })).statusCode).toBe(404);
    }
  });
});

describe('GET /v1/forms/:formId/files/:id (members of the owning org)', () => {
  let pdfId: string;
  let pngId: string;

  beforeAll(async () => {
    pdfId = (await upload({ name: 'résumé "final".pdf' })).json<{ fileId: string }>().fileId;
    pngId = (await upload({ name: 'photo.png', mime: 'image/png', data: b64(PNG) })).json<{ fileId: string }>().fileId;
  });

  it('refuses a caller with no session', async () => {
    for (const headers of [{}, { 'x-fr-org': orgA }]) {
      const res = await app.inject({ url: `/v1/forms/${formId}/files/${pdfId}`, headers });
      expect(res.statusCode).toBe(401);
      expect(res.rawPayload.length).toBeLessThan(2000);
    }
  });

  it('refuses a member of another org, whichever org they name', async () => {
    const naming = await app.inject({ url: `/v1/forms/${formId}/files/${pdfId}`, headers: as(ownerB, orgA) });
    expect(naming.statusCode).toBe(403);
    const own = await app.inject({ url: `/v1/forms/${formId}/files/${pdfId}`, headers: as(ownerB, orgB) });
    expect(own.statusCode).toBe(404);
    expect(own.rawPayload.equals(PDF)).toBe(false);
  });

  it('refuses a member without submissions.read', async () => {
    expect((await app.inject({ url: `/v1/forms/${formId}/files/${pdfId}`, headers: as(creatorA, orgA) })).statusCode).toBe(403);
  });

  it('does not hand a file out under another form of the same org', async () => {
    const res = await app.inject({ url: `/v1/forms/${plainFormId}/files/${pdfId}`, headers: as(ownerA, orgA) });
    expect(res.statusCode).toBe(404);
  });

  it('serves a document as an attachment, never as a page: octet-stream, nosniff, no cache', async () => {
    for (const who of [ownerA, viewerA]) {
      const res = await app.inject({ url: `/v1/forms/${formId}/files/${pdfId}`, headers: as(who, orgA) });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(PDF)).toBe(true);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="r_sum_ _final_\.pdf"; filename\*=UTF-8''r%C3%A9sum%C3%A9%20_final_\.pdf$/);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
    }
  });

  it('serves the image types it knows as themselves, still as an attachment', async () => {
    const res = await app.inject({ url: `/v1/forms/${formId}/files/${pngId}`, headers: as(ownerA, orgA) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('answers 404 for an unknown file and 400 for an id that is not a uuid, so no id can name a path', async () => {
    expect((await app.inject({ url: `/v1/forms/${formId}/files/${randomUUID()}`, headers: as(ownerA, orgA) })).statusCode).toBe(404);
    for (const bad of ['..%2F..%2Fetc%2Fpasswd', '%2e%2e', 'x.bin', `${pdfId}.bin`]) {
      const res = await app.inject({ url: `/v1/forms/${formId}/files/${bad}`, headers: as(ownerA, orgA) });
      expect([400, 404], bad).toContain(res.statusCode);
      expect(res.rawPayload.equals(PDF), bad).toBe(false);
    }
    const store = createFileStore(dir);
    await expect(store.get('../../etc/passwd')).rejects.toThrow(TypeError);
    await expect(store.put('..', Buffer.from('x'))).rejects.toThrow(TypeError);
  });

  it('records the download on the org’s audit chain', async () => {
    await app.inject({ url: `/v1/forms/${formId}/files/${pdfId}`, headers: as(viewerA, orgA) });
    const { rows } = await owner.query<{ event: Record<string, unknown> }>(
      `select event from audit_pending where event->>'action' = 'file.downloaded' and event->>'resourceId' = $1`,
      [pdfId],
    );
    const mine = rows.map((r) => r.event).find((e) => e.actorId === viewerA);
    expect(mine).toMatchObject({ actorId: viewerA, formId, outcome: 'success', resourceType: 'file' });
    expect(JSON.stringify(rows)).not.toContain('résumé');
  });
});
