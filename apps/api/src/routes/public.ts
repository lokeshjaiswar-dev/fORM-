import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest, RequestPayload } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { editionSummary, runtimeEdition, type RuntimeEdition } from '@form/config';
import { formFiles, formFilesCheck, formSubmissions, formVersions, resolveFormSlug, withTenant, type Db } from '@form/db';
import { projectForRuntime } from '@form/logic';
import { acceptsFile } from '@form/registry';
import type { BlockId, CompiledForm, FieldError, FormDefinition, FormId, FormVersion, FormVersionId, IsoInstant, OrgId, Sha256Hex, UserId } from '@form/schema';
import { z } from 'zod';
import type { ApiConfig } from '../config.ts';
import { ProblemError, sendProblem } from '../errors.ts';
import {
  baseMime,
  capBytes,
  contentProblem,
  DEFAULT_ACCEPT,
  isNeverStored,
  MAX_SIGNATURE_BYTES,
  MAX_UPLOAD_BYTES,
  normaliseFileName,
  UPLOAD_BODY_LIMIT,
  uploadBodyLimitFor,
  type FileStore,
} from '../files.ts';
import { displayRows } from '../display-rows.ts';
import { storableJson, storableString } from '../text-safety.ts';
import { bindFileRefs, fileUses } from '../submission-files.ts';
import { checkAnswers } from '../validate-submission.ts';

/** What `publicSlug` makes (lower-case letters, digits, hyphens), allowing a little more; never a control character. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const slugParam = z.object({ slug: z.string().regex(SLUG) });

/** A language tag's shape (`en-IN`, `hi`, `zh-Hant-TW`); which tags a form offers is checked against the form itself. */
const LOCALE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$/;

/**
 * Display rows the page sends along. The server builds the rows it stores from the validated answers and ignores
 * these, but they are still checked like any text that reaches the database: bounded and free of characters Postgres
 * cannot store.
 */
const fieldRow = z.object({ key: storableString(128), label: storableString(1000), value: storableString(10_000) });

type PublicPayload = { slug: string; formId: string; version: unknown; media?: Record<string, string> };

/** A published form as the public routes use it: what the page gets, and the stored definition the server checks against. */
interface LiveForm {
  orgId: string;
  formId: string;
  versionId: string;
  payload: PublicPayload;
  definition: FormDefinition;
  compiled: CompiledForm;
}

/** A version is immutable, so what is loaded for it is good for as long as it is kept; only the memory is bounded. */
const LIVE_CACHE_MAX = 200;
const liveByVersion = new Map<string, LiveForm>();
const liveInflight = new Map<string, Promise<LiveForm>>();

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The biggest request body an upload to this form can need: the largest file one of its fields takes, as base64 in JSON. */
function uploadBodyLimit(live: LiveForm): number {
  let biggest = 0;
  for (const block of Object.values(live.definition.blocks)) {
    if (block?.type === 'file_upload') biggest = Math.max(biggest, Math.min(block.config.maxFileBytes, MAX_UPLOAD_BYTES));
    else if (block?.type === 'signature') biggest = Math.max(biggest, MAX_SIGNATURE_BYTES);
  }
  return uploadBodyLimitFor(biggest);
}

/** The most files one submission may name (the narrow lookup of 0019 takes at most this many ids). */
const MAX_FILES_PER_SUBMISSION = 100;

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
      const live: LiveForm = { orgId: found.orgId, formId: found.formId, versionId: found.liveVersionId, payload, definition: version.definition, compiled: version.compiled };
      if (liveByVersion.size >= LIVE_CACHE_MAX) liveByVersion.delete(liveByVersion.keys().next().value!);
      liveByVersion.set(found.liveVersionId, live);
      return live;
    })().finally(() => liveInflight.delete(found.liveVersionId));
    liveInflight.set(found.liveVersionId, load);
    return load;
  }

  /** The live form of a public request's slug, resolved before its body is read; a refusal closes the connection, so the body is not uploaded for nothing. */
  async function liveBeforeBody(request: FastifyRequest, reply: FastifyReply): Promise<LiveForm> {
    try {
      const slug = (request.params as { slug?: unknown }).slug;
      if (typeof slug !== 'string' || !SLUG.test(slug)) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      return await loadLive(slug, request.id);
    } catch (err) {
      reply.header('connection', 'close');
      throw err;
    }
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

  /**
   * Before the body of an anonymous upload is read: the slug must be a live form (else 404), and a body bigger than the
   * biggest file this form takes (its largest `maxFileBytes`, a signature's 2 MiB) is refused from its `Content-Length`
   * (413) without reading a byte; a body that declares no length is counted as it arrives and cut off past the same
   * limit. Without this, every request read and JSON-parsed up to 14 MB before anything about the form was looked at.
   */
  const guardUpload = async (request: FastifyRequest, reply: FastifyReply, payload: RequestPayload): Promise<RequestPayload> => {
    const live = await liveBeforeBody(request, reply);
    const limit = uploadBodyLimit(live);
    const declared = request.headers['content-length'];
    if (declared !== undefined && Number(declared) > limit) {
      reply.header('connection', 'close');
      throw new ProblemError('PAYLOAD_TOO_LARGE', 'That file is too large.');
    }
    return capBytes(payload, limit, () => new ProblemError('PAYLOAD_TOO_LARGE', 'That file is too large.'));
  };

  r.post(
    '/v1/p/:slug/files',
    {
      config: { auth: 'none' },
      bodyLimit: UPLOAD_BODY_LIMIT,
      preParsing: guardUpload,
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
      const mime = baseMime(declared);
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
          await tx.insert(formFiles).values({ id, orgId: live.orgId, formId: live.formId, blockId, purpose, name, mime, sizeBytes: bytes.length, sha256 });
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
        description:
          'Respondents are anonymous. The answers are for the form\'s live version only (`formVersionId`; an older page gets FORM_OUTDATED), are evaluated and validated on the server, and every file they name must have been uploaded to this form.',
        params: slugParam,
        body: z.object({
          formVersionId: z.uuid(),
          answers: storableJson(z.record(z.string(), z.unknown())),
          fields: z.array(fieldRow).max(500).default([]),
          locale: z.string().min(2).max(35).regex(LOCALE_TAG).default('en-IN'),
        }),
        response: { 200: z.object({ id: z.uuid() }) },
      },
    },
    async (request, reply) => {
      // The slug is resolved now, so a form that is no longer live takes no more answers.
      const live = await loadLive(request.params.slug, request.id);
      if (request.body.formVersionId !== live.versionId) {
        throw new ProblemError('FORM_OUTDATED', 'This form was updated while you were filling it. Reload and try again.');
      }
      // The language is one the form offers: it is stored, and handed to Intl when the answers are checked.
      if (!live.definition.i18n.locales.some((l) => l.locale === request.body.locale)) {
        return sendProblem(reply, 'VALIDATION_FAILED', 'This form is not offered in that language.', [{ path: 'locale', message: 'not a language of this form' }]);
      }
      // The answers are checked against the stored version, whatever the page claims to have validated.
      const checked = checkAnswers(live, live.versionId, request.body.answers, request.body.locale, new Date());
      if (checked.errors.length > 0) return invalid(reply, checked.errors);
      let values = checked.values;
      const uses = fileUses(values);
      const id = randomUUID();
      const stored = await withTenant(deps.db, { orgId: live.orgId, actor: 'respondent', requestId: request.id }, async (tx) => {
        if (uses.length > 0) {
          // Every file the answers name was uploaded to this form, for the very field that holds it, and is the file
          // they say it is. The references are then rewritten from what the upload route recorded (name, type, size,
          // hash), and the answers checked once more against the true type and size.
          const ids = [...new Set(uses.map((use) => String(use.ref['fileId'])))];
          if (ids.length > MAX_FILES_PER_SUBMISSION) throw new ProblemError('VALIDATION_FAILED', 'Too many files in one submission.');
          // Through the narrow definer function: a respondent context cannot read form_files (SR-5).
          const known = ids.every((fileId) => z.uuid().safeParse(fileId).success) ? await formFilesCheck(tx, live.formId, ids) : [];
          const bound = bindFileRefs(values, new Map(known.map((row) => [row.id, row])));
          const again = checkAnswers(live, live.versionId, bound, request.body.locale, new Date());
          if (again.errors.length > 0) return { errors: again.errors };
          values = again.values;
        }
        await tx.insert(formSubmissions).values({
          id,
          orgId: live.orgId,
          formId: live.formId,
          answers: values,
          // Built here from the validated answers; what the page sent along as "rows" is ignored (SR-2).
          fields: displayRows(live.definition, values),
          locale: request.body.locale,
        });
        // The form's counters and the hold on the files are kept by a trigger on this INSERT (0019): a respondent
        // context may not write `forms` or `form_files`.
        return { errors: [] };
      });
      if (stored.errors.length > 0) return invalid(reply, stored.errors);
      return { id };
    },
  );
}

function invalid(reply: FastifyReply, errors: FieldError[]): FastifyReply {
  return sendProblem(
    reply,
    'VALIDATION_FAILED',
    'Some answers are not valid.',
    errors.slice(0, 50).map((e) => ({ path: [e.blockId, e.path].filter(Boolean).join('.'), message: e.message })),
  );
}
