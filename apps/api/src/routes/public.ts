import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { editionSummary, runtimeEdition, type RuntimeEdition } from '@form/config';
import { formFiles, formSubmissions, formVersions, forms, resolveFormSlug, withTenant, type Db } from '@form/db';
import { projectForRuntime } from '@form/logic';
import { acceptsFile } from '@form/registry';
import type { BlockId, CompiledForm, FormDefinition, FormId, FormVersion, FormVersionId, IsoInstant, OrgId, Sha256Hex, UserId } from '@form/schema';
import { z } from 'zod';
import type { ApiConfig } from '../config.ts';
import { ProblemError } from '../errors.ts';
import {
  contentProblem,
  DEFAULT_ACCEPT,
  isNeverStored,
  MAX_SIGNATURE_BYTES,
  MAX_UPLOAD_BYTES,
  normaliseFileName,
  UPLOAD_BODY_LIMIT,
  type FileStore,
} from '../files.ts';

const slugParam = z.object({ slug: z.string().min(1).max(128) });

const fieldRow = z.object({ key: z.string(), label: z.string(), value: z.string() });

type PublicPayload = { slug: string; formId: string; version: unknown; media?: Record<string, string> };

/** A published form as the public routes use it: what the page gets, and the stored definition the server checks against. */
interface LiveForm {
  orgId: string;
  formId: string;
  versionId: string;
  payload: PublicPayload;
  definition: FormDefinition;
}

const SUB_DIR = path.resolve(process.cwd(), '.data/submissions');
const FORM_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A version is immutable, so what is loaded for it is good for as long as it is kept; only the memory is bounded. */
const LIVE_CACHE_MAX = 200;
const liveByVersion = new Map<string, LiveForm>();
const liveInflight = new Map<string, Promise<LiveForm>>();

type DiskSubmission = {
  id: string;
  formId: string;
  submittedAt: string;
  locale: string;
  answers: Record<string, unknown>;
  fields: Array<{ key: string; label: string; value: string }>;
};

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

async function saveSubmission(row: DiskSubmission): Promise<void> {
  const formId = formKey(row.formId);
  if (!FORM_FILE.test(formId)) return;
  const items = (await readSubmissions(formId)).filter((item) => item.id !== row.id);
  items.unshift({ ...row, formId });
  await mkdir(SUB_DIR, { recursive: true });
  await writeFile(subPath(formId), JSON.stringify({ items }));
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function publicFormRoutes(app: FastifyInstance, deps: { db: Db; config: ApiConfig; files: FileStore }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const edition: RuntimeEdition = runtimeEdition(editionSummary(deps.config.edition));

  /**
   * The live version of a slug. The slug is resolved on every request, so a form that was unpublished, archived or
   * trashed stops answering at once; what is loaded for a version id is cached, because a version never changes.
   */
  async function loadLive(slug: string, requestId: string): Promise<LiveForm> {
    const found = await resolveFormSlug(deps.db, slug);
    if (!found) throw new ProblemError('NOT_FOUND', 'This form is not published.');
    const cached = liveByVersion.get(found.liveVersionId);
    if (cached && cached.formId === found.formId) return cached;
    const pending = liveInflight.get(found.liveVersionId);
    if (pending) return pending;
    const load = (async () => {
      // A respondent reads one version of one org's form: the org comes from the slug, never from the caller.
      const rows = await withTenant(deps.db, { orgId: found.orgId, actor: 'respondent', requestId, readOnly: true }, (tx) =>
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
      const payload: PublicPayload = {
        slug,
        formId: found.formId,
        version: projectForRuntime(version, { state: 'open' }, {
          edition,
          upload: { presignUrl: '', maxFileBytes: MAX_UPLOAD_BYTES },
          branding: false,
          thirdPartyTrackingAllowed: false,
        }),
        ...(row.media ? { media: row.media } : {}),
      };
      const live: LiveForm = { orgId: found.orgId, formId: found.formId, versionId: found.liveVersionId, payload, definition: version.definition };
      if (liveByVersion.size >= LIVE_CACHE_MAX) liveByVersion.delete(liveByVersion.keys().next().value!);
      liveByVersion.set(found.liveVersionId, live);
      return live;
    })().finally(() => liveInflight.delete(found.liveVersionId));
    liveInflight.set(found.liveVersionId, load);
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
    async (request) => ({ ...(await loadLive(request.params.slug, request.id)).payload, slug: request.params.slug }),
  );

  const uploaded = z.object({
    fileId: z.uuid(),
    name: z.string(),
    sizeBytes: z.number().int(),
    mime: z.string(),
    sha256: z.string(),
    scan: z.literal('skipped'),
  });

  r.post(
    '/v1/p/:slug/files',
    {
      config: { auth: 'none' },
      bodyLimit: UPLOAD_BODY_LIMIT,
      schema: {
        tags: ['runtime'],
        summary: 'Upload a file to an upload or signature field of a published form',
        description:
          "Respondents are anonymous, so this is public, but it only takes files for a field the form's live version has, within that field's type and size rules. The server names the file (a uuid); a client-chosen id is ignored. Downloads are for signed-in members of the owning org only.",
        params: slugParam,
        body: z.object({
          blockId: z.string().min(1).max(64),
          purpose: z.enum(['file', 'signature']).default('file'),
          name: z.string().min(1).max(255),
          mime: z.string().min(1).max(255),
          data: z.string().min(1),
        }),
        response: { 200: uploaded },
      },
    },
    async (request) => {
      const { blockId, purpose, mime: declared, data } = request.body;
      const live = await loadLive(request.params.slug, request.id);
      const block = live.definition.blocks[blockId as BlockId];
      if (!block || block.type !== (purpose === 'signature' ? 'signature' : 'file_upload')) {
        throw new ProblemError('VALIDATION_FAILED', 'This form has no field that takes a file here.');
      }

      const name = purpose === 'signature' ? 'signature.png' : normaliseFileName(request.body.name);
      const mime = declared.trim().toLowerCase();
      let max: number;
      if (block.type === 'file_upload') {
        const configured = block.config.accept;
        const accept =
          configured.extensions.length === 0 && configured.mimeTypes.length === 0
            ? { extensions: [...DEFAULT_ACCEPT.extensions], mimeTypes: [...DEFAULT_ACCEPT.mimeTypes] }
            : configured;
        if (isNeverStored(name, mime) || !acceptsFile({ name, mime }, accept)) {
          throw new ProblemError('UNSUPPORTED_MEDIA_TYPE', 'This kind of file is not accepted here.');
        }
        max = Math.min(block.config.maxFileBytes, MAX_UPLOAD_BYTES);
      } else {
        if (mime !== 'image/png') throw new ProblemError('UNSUPPORTED_MEDIA_TYPE', 'A signature is a PNG picture.');
        max = MAX_SIGNATURE_BYTES;
      }
      // Checked before decoding, so an oversize body never becomes a buffer.
      if (data.length > Math.ceil(max / 3) * 4 + 4) throw new ProblemError('PAYLOAD_TOO_LARGE', 'That file is too large.');
      if (!BASE64.test(data)) throw new ProblemError('VALIDATION_FAILED', 'The file could not be read.');
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length === 0) throw new ProblemError('VALIDATION_FAILED', 'The file is empty.');
      if (bytes.length > max) throw new ProblemError('PAYLOAD_TOO_LARGE', 'That file is too large.');
      if (contentProblem(bytes, name, mime)) throw new ProblemError('UNSUPPORTED_MEDIA_TYPE', 'The file is not the kind of file its name says.');

      const id = randomUUID();
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      try {
        await withTenant(deps.db, { orgId: live.orgId, actor: 'respondent', requestId: request.id }, async (tx) => {
          await tx.insert(formFiles).values({ id, orgId: live.orgId, formId: live.formId, blockId, name, mime, sizeBytes: bytes.length, sha256 });
          // Bytes before commit: a failed write rolls the row back; a failed commit leaves an unreferenced file, removed below.
          await deps.files.put(id, bytes);
        });
      } catch (err) {
        await deps.files.remove(id);
        throw err;
      }
      return { fileId: id, name, sizeBytes: bytes.length, mime, sha256, scan: 'skipped' as const };
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
      const live = await loadLive(request.params.slug, request.id);
      if (request.body.formVersionId !== live.versionId) {
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
