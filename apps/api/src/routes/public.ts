import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { editionSummary, runtimeEdition, type RuntimeEdition } from '@form/config';
import { formDrafts, formSubmissions, formVersions, forms, resolveFormSlug, withTenant, type Db } from '@form/db';
import { projectForRuntime } from '@form/logic';
import { uniqueFieldErrors, type CompiledForm, type FormDefinition, type FormId, type FormVersion, type FormVersionId, type IsoInstant, type OrgId, type PublicFormDefinition, type Sha256Hex, type UserId } from '@form/schema';
import { z } from 'zod';
import type { ApiConfig } from '../config.ts';
import { ProblemError, sendProblem } from '../errors.ts';

const slugParam = z.object({ slug: z.string().min(1).max(128) });

const fieldRow = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  table: z.object({ headers: z.array(z.string()), rows: z.array(z.array(z.string())) }).optional(),
  choices: z.array(z.string()).optional(),
});

type PublicPayload = { slug: string; formId: string; version: unknown; media?: Record<string, string> };

const LIVE_DIR = path.resolve(process.cwd(), '.data/published');
const SUB_DIR = path.resolve(process.cwd(), '.data/submissions');
const FILE_DIR = path.resolve(process.cwd(), '.data/files');
const SLUG_FILE = /^[a-z0-9][a-z0-9-]{0,127}$/i;
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
  fields: Array<{ key: string; label: string; value: string; table?: { headers: string[]; rows: string[][] } | undefined; choices?: string[] | undefined }>;
};

function livePath(slug: string): string {
  return path.join(LIVE_DIR, `${slug}.json`);
}

export async function savePublished(body: PublicPayload): Promise<void> {
  if (!SLUG_FILE.test(body.slug)) return;
  liveCache.set(body.slug, { at: Date.now(), body });
  await mkdir(LIVE_DIR, { recursive: true });
  await writeFile(livePath(body.slug), JSON.stringify(body));
}

export function forgetPublished(slug?: string): void {
  if (slug) {
    liveCache.delete(slug);
    void unlink(livePath(slug)).catch(() => undefined);
  } else liveCache.clear();
}

async function readPublishedFile(slug: string): Promise<PublicPayload | null> {
  if (!SLUG_FILE.test(slug)) return null;
  try {
    const parsed = JSON.parse(await readFile(livePath(slug), 'utf8')) as PublicPayload;
    if (parsed?.slug === slug && parsed.formId && parsed.version) return parsed;
  } catch {
    /* Missing or unreadable. */
  }
  return null;
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
  const cached = liveCache.get(slug);
  if (cached) return cached.body;
  return readPublishedFile(slug);
}

export function publicFormRoutes(app: FastifyInstance, deps: { db: Db; config: ApiConfig }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const edition: RuntimeEdition = runtimeEdition(editionSummary(deps.config.edition));

  async function loadLive(slug: string, requestId: string): Promise<PublicPayload> {
    const cached = liveCache.get(slug);
    if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.body;
    // The database is the source of truth. The disk copy only covers forms published before it was.
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
      const drafts = await withTenant(deps.db, { orgId: found.orgId, actor: 'system', requestId, readOnly: true }, (tx) =>
        tx.select({ draft: formDrafts.draft }).from(formDrafts).where(eq(formDrafts.formId, found.formId)).limit(1),
      );
      const storedMedia = drafts[0]?.draft?.media;
      const media =
        storedMedia && typeof storedMedia === 'object' && !Array.isArray(storedMedia)
          ? Object.fromEntries(Object.entries(storedMedia as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
          : undefined;
      const body: PublicPayload = {
        slug,
        formId: found.formId,
        ...(media && Object.keys(media).length ? { media } : {}),
        version: projectForRuntime(version, { state: 'open' }, {
          edition,
          upload: { presignUrl: '', maxFileBytes: 10 * 1024 * 1024 },
          branding: false,
          thirdPartyTrackingAllowed: false,
        }),
      };
      await savePublished(body);
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
    async (request, reply) => {
      const live = (await peekLive(request.params.slug)) ?? (await loadLive(request.params.slug, request.id).catch(() => null));
      if (!live) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      const expected = versionIdOf(live.version);
      if (expected && request.body.formVersionId !== expected) {
        throw new ProblemError('NOTICE_OUTDATED', 'This form was updated. Reload and try again.');
      }
      const taken = await uniqueAgainstDb(deps.db, request.params.slug, request.id, live.version, request.body.answers);
      if (taken.length) {
        return sendProblem(
          reply,
          'VALIDATION_FAILED',
          taken[0]?.message ?? 'This value has already been used.',
          taken.map((error) => ({ path: error.blockId, message: error.message })),
        );
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

  r.get(
    '/v1/p/by-form/:formId/submissions',
    {
      config: { auth: 'none' },
      schema: {
        tags: ['runtime'],
        summary: 'List submissions for a published form (no sign-in)',
        params: z.object({ formId: z.uuid() }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.uuid(),
                formId: z.uuid(),
                submittedAt: z.string(),
                fieldCount: z.number().int(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const items = await readSubmissions(request.params.formId);
      return {
        items: items.map((row) => ({
          id: row.id,
          formId: row.formId,
          submittedAt: row.submittedAt,
          fieldCount: row.fields.length,
        })),
      };
    },
  );

  r.get(
    '/v1/p/by-form/:formId/submissions/:id',
    {
      config: { auth: 'none' },
      schema: {
        tags: ['runtime'],
        summary: 'Read one public submission',
        params: z.object({ formId: z.uuid(), id: z.uuid() }),
        response: {
          200: z.object({
            id: z.uuid(),
            formId: z.uuid(),
            submittedAt: z.string(),
            locale: z.string(),
            answers: z.record(z.string(), z.unknown()),
            fields: z.array(fieldRow),
          }),
        },
      },
    },
    async (request) => {
      const row = (await readSubmissions(request.params.formId)).find((item) => item.id === request.params.id);
      if (!row) throw new ProblemError('NOT_FOUND', 'That submission is not on this form.');
      return row;
    },
  );
}

async function uniqueAgainstDb(db: Db, slug: string, requestId: string, version: unknown, answers: Record<string, unknown>) {
  const definition = definitionOf(version);
  if (!definition) return [];
  const found = await resolveFormSlug(db, slug);
  if (!found) return [];
  const rows = await withTenant(db, { orgId: found.orgId, actor: 'system', requestId, readOnly: true }, (tx) =>
    tx.select({ answers: formSubmissions.answers }).from(formSubmissions).where(eq(formSubmissions.formId, found.formId)),
  );
  return uniqueFieldErrors(definition.blocks, answers, rows.map((row) => row.answers));
}

function definitionOf(version: unknown): PublicFormDefinition | null {
  if (typeof version !== 'object' || version === null || !('definition' in version)) return null;
  const definition = (version as { definition: unknown }).definition;
  if (typeof definition !== 'object' || definition === null || !('blocks' in definition)) return null;
  return definition as PublicFormDefinition;
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
      versionId: found.liveVersionId,
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
