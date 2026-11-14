import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { editionSummary, runtimeEdition, type RuntimeEdition } from '@form/config';
import { formSubmissions, formVersions, forms, resolveFormSlug, withTenant, type Db } from '@form/db';
import { projectForRuntime } from '@form/logic';
import type { CompiledForm, FormDefinition, FormId, FormVersion, FormVersionId, IsoInstant, OrgId, Sha256Hex, UserId } from '@form/schema';
import { z } from 'zod';
import type { ApiConfig } from '../config.ts';
import { ProblemError } from '../errors.ts';

const slugParam = z.object({ slug: z.string().min(1).max(128) });

const fieldRow = z.object({ key: z.string(), label: z.string(), value: z.string() });

type PublicPayload = { slug: string; formId: string; version: unknown; media?: Record<string, string> };

const SUB_DIR = path.resolve(process.cwd(), '.data/submissions');
const FILE_DIR = path.resolve(process.cwd(), '.data/files');
const FORM_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_BODY_LIMIT = 12 * 1024 * 1024;
const LIVE_TTL_MS = 60_000;
const liveCache = new Map<string, { at: number; body: PublicPayload }>();
const liveInflight = new Map<string, Promise<PublicPayload>>();

type DiskSubmission = {
  id: string;
  formId: string;
  submittedAt: string;
  locale: string;
  answers: Record<string, unknown>;
  fields: Array<{ key: string; label: string; value: string }>;
};

/** Drops the cached public copy of a slug (after a publish); other instances catch up when the entry expires. */
export function forgetPublished(slug?: string): void {
  if (slug) liveCache.delete(slug);
  else liveCache.clear();
}

function versionIdOf(version: unknown): string | undefined {
  if (typeof version !== 'object' || version === null || !('versionId' in version)) return undefined;
  const id = (version as { versionId: unknown }).versionId;
  return typeof id === 'string' ? id : undefined;
}

function formKey(formId: string): string {
  return formId.toLowerCase();
}

function subPath(formId: string): string {
  return path.join(SUB_DIR, `${formKey(formId)}.json`);
}

async function readSubmissions(formId: string): Promise<DiskSubmission[]> {
  const id = formKey(formId);
  if (!FORM_FILE.test(id)) return [];
  try {
    const parsed = JSON.parse(await readFile(subPath(id), 'utf8')) as { items?: DiskSubmission[] };
    return Array.isArray(parsed.items) ? parsed.items.filter((row) => row && formKey(row.formId) === id && row.id) : [];
  } catch {
    return [];
  }
}

function fileBinPath(id: string): string {
  return path.join(FILE_DIR, `${id}.bin`);
}

function fileMetaPath(id: string): string {
  return path.join(FILE_DIR, `${id}.json`);
}

async function saveUploadedFile(id: string, name: string, mime: string, bytes: Buffer): Promise<void> {
  await mkdir(FILE_DIR, { recursive: true });
  await writeFile(fileBinPath(id), bytes);
  await writeFile(fileMetaPath(id), JSON.stringify({ name, mime }));
}

async function readUploadedFile(id: string): Promise<{ name: string; mime: string; bytes: Buffer } | null> {
  if (!FORM_FILE.test(id)) return null;
  try {
    const meta = JSON.parse(await readFile(fileMetaPath(id), 'utf8')) as { name?: unknown; mime?: unknown };
    if (typeof meta.name !== 'string' || typeof meta.mime !== 'string') return null;
    const bytes = await readFile(fileBinPath(id));
    return { name: meta.name, mime: meta.mime, bytes };
  } catch {
    return null;
  }
}

async function saveSubmission(row: DiskSubmission): Promise<void> {
  const formId = formKey(row.formId);
  if (!FORM_FILE.test(formId)) return;
  const items = (await readSubmissions(formId)).filter((item) => item.id !== row.id);
  items.unshift({ ...row, formId });
  await mkdir(SUB_DIR, { recursive: true });
  await writeFile(subPath(formId), JSON.stringify({ items }));
}

async function peekLive(slug: string): Promise<PublicPayload | null> {
  return liveCache.get(slug)?.body ?? null;
}

export function publicFormRoutes(app: FastifyInstance, deps: { db: Db; config: ApiConfig }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const edition: RuntimeEdition = runtimeEdition(editionSummary(deps.config.edition));

  async function loadLive(slug: string, requestId: string): Promise<PublicPayload> {
    const cached = liveCache.get(slug);
    if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.body;
    const pending = liveInflight.get(slug);
    if (pending) return pending;
    const load = (async () => {
      const found = await resolveFormSlug(deps.db, slug);
      if (!found) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      const rows = await withTenant(deps.db, { orgId: found.orgId, actor: 'system', requestId, readOnly: true }, (tx) =>
        tx
          .select({
            id: formVersions.id,
            orgId: formVersions.orgId,
            formId: formVersions.formId,
            number: formVersions.number,
            schemaVersion: formVersions.schemaVersion,
            publishedAt: formVersions.publishedAt,
            publishedBy: formVersions.publishedBy,
            definition: formVersions.definition,
            compiled: formVersions.compiled,
            contentHash: formVersions.contentHash,
            media: formVersions.media,
          })
          .from(formVersions)
          .where(and(eq(formVersions.id, found.liveVersionId), eq(formVersions.formId, found.formId)))
          .limit(1),
      );
      const row = rows[0];
      if (!row) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      const version: FormVersion = {
        id: row.id as FormVersionId,
        orgId: row.orgId as OrgId,
        formId: row.formId as FormId,
        number: row.number,
        schemaVersion: row.schemaVersion,
        publishedAt: row.publishedAt.toISOString() as IsoInstant,
        publishedBy: row.publishedBy as UserId,
        definition: row.definition as unknown as FormDefinition,
        compiled: row.compiled as unknown as CompiledForm,
        contentHash: row.contentHash as Sha256Hex,
        templateLineage: [],
        variablesSnapshot: { variables: {} },
      };
      const body: PublicPayload = {
        slug,
        formId: found.formId,
        version: projectForRuntime(version, { state: 'open' }, {
          edition,
          upload: { presignUrl: '', maxFileBytes: 10 * 1024 * 1024 },
          branding: false,
          thirdPartyTrackingAllowed: false,
        }),
        ...(row.media ? { media: row.media } : {}),
      };
      liveCache.set(slug, { at: Date.now(), body });
      return body;
    })().finally(() => liveInflight.delete(slug));
    liveInflight.set(slug, load);
    return load;
  }

  r.get(
    '/v1/p/:slug',
    {
      config: { auth: 'none' },
      schema: {
        tags: ['runtime'],
        summary: 'Public runtime projection of the live version',
        params: slugParam,
        response: {
          200: z.object({
            slug: z.string(),
            formId: z.uuid(),
            version: z.unknown(),
            media: z.record(z.string(), z.string()).optional(),
          }),
        },
      },
    },
    async (request) => loadLive(request.params.slug, request.id),
  );

  r.post(
    '/v1/p/files',
    {
      config: { auth: 'none' },
      bodyLimit: FILE_BODY_LIMIT,
      schema: {
        tags: ['runtime'],
        summary: 'Store a respondent file so Responses can open it on another device',
        body: z.object({
          id: z.uuid(),
          name: z.string().min(1).max(255),
          mime: z.string().min(1).max(255),
          data: z.string().min(1),
        }),
        response: { 200: z.object({ id: z.uuid() }) },
      },
    },
    async (request) => {
      const { id, name, mime, data } = request.body;
      let bytes: Buffer;
      try {
        bytes = Buffer.from(data, 'base64');
      } catch {
        throw new ProblemError('VALIDATION_FAILED', 'The file could not be read.');
      }
      if (bytes.length === 0 || bytes.length > FILE_BODY_LIMIT) {
        throw new ProblemError('PAYLOAD_TOO_LARGE', 'That file is too large.');
      }
      await saveUploadedFile(id, name, mime, bytes);
      return { id };
    },
  );

  r.get(
    '/v1/p/files/:id',
    {
      config: { auth: 'none' },
      schema: {
        tags: ['runtime'],
        summary: 'Download a stored respondent file',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const file = await readUploadedFile(request.params.id);
      if (!file) throw new ProblemError('NOT_FOUND', 'That file is not stored.');
      return reply
        .header('x-file-name', encodeURIComponent(file.name))
        .type(file.mime)
        .send(file.bytes);
    },
  );

  r.post(
    '/v1/p/:slug/submissions',
    {
      config: { auth: 'none' },
      schema: {
        tags: ['runtime'],
        summary: 'Submit answers on a published form',
        params: slugParam,
        body: z.object({
          formVersionId: z.uuid(),
          answers: z.record(z.string(), z.unknown()),
          fields: z.array(fieldRow).default([]),
          locale: z.string().min(2).max(35).default('en-IN'),
        }),
        response: { 200: z.object({ id: z.uuid() }) },
      },
    },
    async (request) => {
      const live = (await peekLive(request.params.slug)) ?? (await loadLive(request.params.slug, request.id).catch(() => null));
      if (!live) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      const expected = versionIdOf(live.version);
      if (expected && request.body.formVersionId !== expected) {
        throw new ProblemError('NOTICE_OUTDATED', 'This form was updated. Reload and try again.');
      }
      const id = randomUUID();
      const row: DiskSubmission = {
        id,
        formId: live.formId,
        submittedAt: new Date().toISOString(),
        locale: request.body.locale,
        answers: request.body.answers,
        fields: request.body.fields,
      };
      await saveSubmission(row);
      void persistSubmissionToDb(deps.db, request.params.slug, request.id, row).catch(() => undefined);
      return { id };
    },
  );

  r.post(
    '/v1/p/by-form/:formId/submissions',
    {
      config: { auth: 'none' },
      schema: {
        tags: ['runtime'],
        summary: 'Store a submission for a form id when the public slug is not used',
        params: z.object({ formId: z.uuid() }),
        body: z.object({
          answers: z.record(z.string(), z.unknown()),
          fields: z.array(fieldRow).default([]),
          locale: z.string().min(2).max(35).default('en-IN'),
        }),
        response: { 200: z.object({ id: z.uuid() }) },
      },
    },
    async (request) => {
      const id = randomUUID();
      await saveSubmission({
        id,
        formId: request.params.formId,
        submittedAt: new Date().toISOString(),
        locale: request.body.locale,
        answers: request.body.answers,
        fields: request.body.fields,
      });
      return { id };
    },
  );
}

async function persistSubmissionToDb(db: Db, slug: string, requestId: string, row: DiskSubmission): Promise<void> {
  const found = await resolveFormSlug(db, slug);
  if (!found) return;
  await withTenant(db, { orgId: found.orgId, actor: 'system', requestId }, async (tx) => {
    await tx.insert(formSubmissions).values({
      id: row.id,
      orgId: found.orgId,
      formId: found.formId,
      answers: row.answers,
      fields: row.fields,
      locale: row.locale,
    });
    await tx
      .update(forms)
      .set({
        submissionCount: sql`${forms.submissionCount} + 1`,
        lastSubmissionAt: new Date(),
      })
      .where(eq(forms.id, found.formId));
  });
}
