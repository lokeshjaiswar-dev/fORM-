import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest, RequestPayload } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { editionSummary, runtimeEdition, type RuntimeEdition } from '@form/config';
import { formFiles, resolveFormSlug, withTenant, type Db, type ResolvedFormSlug } from '@form/db';
import { acceptsFile } from '@form/registry';
import type { BlockId } from '@form/schema';
import { z } from 'zod';
import type { ApiConfig } from '../config.ts';
import { clientInfo } from '../auth.ts';
import { ProblemError, sendProblem } from '../errors.ts';
import type { Throttle, ThrottleKey } from '../modules/auth/throttle.ts';
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
import { runtimeStatus } from '../runtime/status.ts';
import { isUnlocked, readAccess } from '../submit/access.ts';
import type { EffectsDeps } from '../submit/effects.ts';
import { createVersionLoader, type LoadedVersion } from '../submit/live.ts';
import { submit } from '../submit/pipeline.ts';
import { storableJson, storableString } from '../text-safety.ts';

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

/**
 * What the page says about the page view (`SubmissionRequest.client`): all of it advisory. The server re-runs the
 * evaluation with it, and stores the address without its query, the referrer's host and the device (`submit/meta.ts`).
 * Unknown keys are dropped.
 */
const clientDetails = storableJson(
  z.object({
    startedAt: z.iso.datetime({ offset: true }).optional(),
    urlParams: z.record(z.string().max(128), z.string().max(2048)).refine((params) => Object.keys(params).length <= 100, 'at most 100 parameters').optional(),
    pageUrl: z.string().max(2048).optional(),
    referrer: z.string().max(2048).optional(),
    device: z.enum(['desktop', 'tablet', 'mobile']).optional(),
    embedOrigin: z.string().max(2048).optional(),
  }),
);

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The biggest request body an upload to this form can need: the largest file one of its fields takes, as base64 in JSON. */
function uploadBodyLimit(live: LoadedVersion): number {
  let biggest = 0;
  for (const block of Object.values(live.definition.blocks)) {
    if (block?.type === 'file_upload') biggest = Math.max(biggest, Math.min(block.config.maxFileBytes, MAX_UPLOAD_BYTES));
    else if (block?.type === 'signature') biggest = Math.max(biggest, MAX_SIGNATURE_BYTES);
  }
  return uploadBodyLimitFor(biggest);
}

const UUID = z.uuid();

/** The `Idempotency-Key` header: exactly one uuid, in lower case; null for anything else (absent, repeated, not a uuid). */
function idempotencyKeyOf(request: FastifyRequest): string | null {
  const raw = request.headers['idempotency-key'];
  return typeof raw === 'string' && UUID.safeParse(raw).success ? raw.toLowerCase() : null;
}

/** The `X-FR-Access` header (the token `POST /v1/p/:slug/unlock` hands out), when it is a single value. */
const accessTokenOf = (request: FastifyRequest): string | undefined => {
  const raw = request.headers['x-fr-access'];
  return typeof raw === 'string' ? raw : undefined;
};

export function publicFormRoutes(
  app: FastifyInstance,
  deps: { db: Db; config: ApiConfig; files: FileStore; throttle: Throttle; now: () => Date; effects?: EffectsDeps | undefined },
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const edition: RuntimeEdition = runtimeEdition(editionSummary(deps.config.edition));
  const loader = createVersionLoader({ db: deps.db, edition });

  /**
   * The live version of a resolved slug. The slug is resolved on every request, so a form that was unpublished,
   * archived or trashed stops answering at once; what is loaded for a version id is cached, because a version never changes.
   */
  async function liveOf(found: ResolvedFormSlug, requestId: string): Promise<LoadedVersion> {
    const live = await loader.get(found, found.liveVersionId, requestId);
    if (!live) throw new ProblemError('NOT_FOUND', 'This form is not published.');
    return live;
  }

  /**
   * Before the body of an anonymous write (an upload or a submission) is read: counts the request against the caller's
   * limits, and resolves the form. The caller is an IP hash (a keyed hash of the address, never the address): first
   * its budget over every form, before anything about the form is looked up, then its budget for this form. Past either
   * is `429` problem+json with `Retry-After`, audited once per window like the sign-in limits. An unknown form is a 404,
   * whatever the body. Every refusal closes the connection, so a client does not go on sending a body nobody reads.
   */
  async function admit(request: FastifyRequest, reply: FastifyReply, kind: 'files' | 'submit'): Promise<ResolvedFormSlug> {
    try {
      const { ipHash } = clientInfo(request, deps.config.auth.secret, deps.now());
      const [ipBucket, formBucket] = kind === 'files' ? (['auth_files_ip', 'auth_files_form'] as const) : (['auth_submit_ip', 'auth_submit_form'] as const);
      const tooMany = 'Too many requests from this address. Try again later.';
      await deps.throttle.hit(request, reply, [{ bucket: ipBucket, key: ipHash }], { ipHash }, tooMany);
      const slug = (request.params as { slug?: unknown }).slug;
      if (typeof slug !== 'string' || !SLUG.test(slug)) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      const found = await resolveFormSlug(deps.db, slug);
      if (!found) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      const perForm: ThrottleKey = { bucket: formBucket, key: new Uint8Array(createHash('sha256').update(ipHash).update(found.formId).digest().subarray(0, 16)) };
      await deps.throttle.hit(request, reply, [perForm], { ipHash }, tooMany);
      return found;
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
        summary: 'Public runtime projection of the live version, with the form\'s status',
        description:
          "What a respondent's page needs to open a form: its status now (open, closed, not yet open, outside hours, limit reached, or password) and, unless the form is behind its password, the live version's runtime projection. " +
          'A password form answers with its status only (the definition is withheld) until the request carries a valid `X-FR-Access` token from `POST /v1/p/:slug/unlock`. ' +
          'A slug the form used to have answers `{ redirectTo }` with the form\'s current slug. Never cached: the status depends on the time and the counter.',
        params: slugParam,
        response: {
          200: z.union([
            z.object({
              slug: z.string(),
              formId: z.uuid(),
              status: z.unknown(),
              version: z.unknown().optional(),
              media: z.record(z.string(), z.string()).optional(),
            }),
            z.object({ redirectTo: z.string() }),
          ]),
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const { slug } = request.params;
      const found = await resolveFormSlug(deps.db, slug);
      if (!found) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      // An address the form used to have: the page moves to the current one before it asks for anything else.
      if (found.primarySlug !== slug) return { redirectTo: found.primarySlug };

      const now = deps.now();
      const { access, submittedTotal } = await withTenant(deps.db, { orgId: found.orgId, actor: 'respondent', requestId: request.id, readOnly: true }, (tx) => readAccess(tx, found.formId));
      // A token is for the version that is live now: a republish after the unlock asks for the password again.
      const unlocked = isUnlocked(deps.config.auth.secret, access, accessTokenOf(request), { formId: found.formId, versionScope: found.liveVersionId }, now);
      const status = runtimeStatus(access, { submittedTotal }, now, { unlocked });
      // The definition does not leave the server until the password has been given, whatever the status says: the status
      // order puts closed, not yet open, full and outside hours before the password, and a form in any of those states
      // still holds questions that only people who know the password may read.
      if (access.hasPassword && !unlocked) return { slug, formId: found.formId, status };

      const live = await liveOf(found, request.id);
      return { slug, formId: found.formId, status, version: { ...live.runtime, status }, ...(live.media ? { media: live.media } : {}) };
    },
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
    const found = await admit(request, reply, 'files');
    const limit = uploadBodyLimit(await liveOf(found, request.id));
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
      const found = await resolveFormSlug(deps.db, request.params.slug);
      if (!found) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      const live = await liveOf(found, request.id);
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
      // Public, with no session: a respondent has no account. What a stranger with `curl` and a form address can do here
      // is write one response at a time to a live form, within its status, its limit and the address's budgets (below);
      // the org, the id, the moment, the status and every stored column are the server's (`submit/pipeline.ts`).
      config: { auth: 'none' },
      // Limits and the slug are looked at before the body (up to 1 MiB of answers) is read and parsed.
      preParsing: async (request, reply, payload) => {
        await admit(request, reply, 'submit');
        return payload;
      },
      schema: {
        tags: ['runtime'],
        summary: 'Submit answers on a published form',
        description:
          "Respondents are anonymous. `Idempotency-Key` (a uuid, the same for every retry of one submission) is required: a retry with the same body gets the first answer back with `Idempotent-Replayed: true` and counts nothing, the same key with other answers is 422 `IDEMPOTENCY_KEY_REUSED`. " +
          "The answers are for `formVersionId`, which must be the live version or the one it replaced within the form's `acceptPreviousVersionsHours` (else 409 `VERSION_SUPERSEDED`). " +
          'They are evaluated and validated on the server (422 `SUBMISSION_INVALID` with each field named), every file they name must have been uploaded to this form, and the form must be open: 409 `FORM_CLOSED` or `LIMIT_REACHED`, or 401 `PASSWORD_REQUIRED` without a valid `X-FR-Access` token.',
        params: slugParam,
        body: z.object({
          formVersionId: z.uuid(),
          answers: storableJson(z.record(z.string(), z.unknown())),
          fields: z.array(fieldRow).max(500).default([]),
          locale: z.string().min(2).max(35).regex(LOCALE_TAG).default('en-IN'),
          client: clientDetails.optional(),
        }),
        response: { 200: z.object({ ok: z.literal(true), submissionId: z.uuid(), endingId: z.string() }) },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const idempotencyKey = idempotencyKeyOf(request);
      if (idempotencyKey === null) {
        return sendProblem(reply, 'VALIDATION_FAILED', 'Send an Idempotency-Key header: a uuid that stays the same whenever this submission is retried.', [
          { path: 'headers.idempotency-key', message: 'required, one uuid' },
        ]);
      }
      const { formVersionId, answers, locale, client } = request.body;
      const userAgent = request.headers['user-agent'];
      const outcome = await submit(
        { db: deps.db, secret: deps.config.auth.secret, loader, now: deps.now, effects: deps.effects },
        {
          slug: request.params.slug,
          requestId: request.id,
          idempotencyKey,
          accessToken: accessTokenOf(request),
          userAgent: typeof userAgent === 'string' ? userAgent : undefined,
          body: { formVersionId, answers, locale, client },
        },
      );
      if (outcome.kind === 'invalid') return sendProblem(reply, 'SUBMISSION_INVALID', outcome.detail, outcome.errors);
      if (outcome.replayed) reply.header('idempotent-replayed', 'true');
      return outcome.result;
    },
  );
}
