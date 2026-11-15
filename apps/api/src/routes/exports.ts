import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  EXPORT_FORMATS,
  EXPORT_STATUSES,
  audit,
  auditActor,
  auditReads,
  exportJobs,
  forms,
  txExecutor,
  withTenant,
  type Db,
  type ExportScope,
  type ExportStatus,
  type ReadClient,
  type TenantCtx,
} from '@form/db';
import { isPortError, type ByteStream, type Queue, type Storage } from '@form/ports';
import { accountOf, clientInfo, tenantOf } from '../auth.ts';
import { ProblemError } from '../errors.ts';
import { attachmentHeader } from '../files.ts';
import { hex } from '../modules/auth/crypto.ts';

export interface ExportRouteDeps {
  /** The request pool: every read and write goes through `withTenant` on it, so row-level security limits it to the caller's org. */
  db: Db;
  /** The small separate pool for denied and failed audit records (ADR-0006). */
  auditDb: Db;
  /** Core's producer queue: a request sends `export.build` through it inside the transaction that inserts the export. */
  queue?: Queue | undefined;
  /** Keys the IP hash of audit records (`config.auth.secret`). */
  secret: Uint8Array;
  now: () => Date;
  /** Where the finished files are kept and streamed from (the composition root passes it once the exports are wired); without it the routes answer 503. */
  storage?: Storage | undefined;
}

const SECURITY = [{ session: [], org: [] }, { devUser: [], org: [] }];
const idParam = z.object({ id: z.uuid() });
const formParam = z.object({ formId: z.uuid() });

/** The most responses one `selected` export names (the grid's own bulk limit is 500; the export takes the page of a whole inbox). */
export const MAX_SELECTED = 1000;
/** Exports queued or running for one org at a time. */
export const MAX_ACTIVE = 10;
/** Exports one org may ask for in any 24 hours (a replay of an Idempotency-Key is not a new one). */
export const MAX_PER_DAY = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A queued or running export older than this no longer counts toward the concurrency limit. The job's own timeout is an
 * hour with two retries, so a row that is still `running` after this long has lost its worker, and must not hold one of
 * the org's ten places for ever (the sweep that marks it `expired` is WP-1.22).
 */
const ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** What a refusal for too many at once tells the caller to wait: a build is minutes, not seconds. */
const BUSY_RETRY_AFTER_SECONDS = 30;

const isoInstant = z.iso.datetime({ offset: true });

/** Visible ASCII, 1 to 255 characters: the `exports.idempotency_key` column's own limit. The builder sends a uuid. */
const idempotencyHeaders = z.object({ 'idempotency-key': z.string().regex(/^[\x21-\x7e]{1,255}$/, 'a key of 1 to 255 visible characters, the same for every retry of one request') });

const scopeBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('selected'), ids: z.array(z.uuid()).min(1).max(MAX_SELECTED) }).strict(),
  z
    .object({ kind: z.literal('filtered'), from: isoInstant.optional(), to: isoInstant.optional() })
    .strict()
    .refine((s) => s.from === undefined || s.to === undefined || Date.parse(s.from) <= Date.parse(s.to), { message: '`from` must not be after `to`', path: ['from'] }),
]);

const requestBody = z
  .object({
    format: z.enum(EXPORT_FORMATS),
    scope: scopeBody,
    /** Whether encrypted and sensitive fields are written in full. They are masked otherwise. Needs `reason`. */
    includeSensitive: z.boolean().default(false),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();

const scopeView = z.object({
  kind: z.enum(['all', 'selected', 'filtered']),
  /** `selected`: how many responses were named (the ids are not echoed). */
  count: z.number().int().optional(),
  from: isoInstant.optional(),
  to: isoInstant.optional(),
});

const exportView = z.object({
  id: z.uuid(),
  formId: z.uuid(),
  format: z.enum(EXPORT_FORMATS),
  scope: scopeView,
  includeSensitive: z.boolean(),
  /** `expired` also when the file is `ready` but past its time and the sweep has not marked it yet. */
  status: z.enum(EXPORT_STATUSES),
  rowCount: z.number().int().nullable(),
  bytes: z.number().int().nullable(),
  /** Why a `failed` export failed, scrubbed by the worker; null otherwise. */
  error: z.string().nullable(),
  createdAt: isoInstant,
  finishedAt: isoInstant.nullable(),
  expiresAt: isoInstant.nullable(),
});
type ExportView = z.infer<typeof exportView>;

type ExportRow = typeof exportJobs.$inferSelect;

/** What the status of a row is for the caller: a `ready` file past its time is `expired` whether or not the sweep has said so. */
function statusOf(row: ExportRow, now: Date): ExportStatus {
  return row.status === 'ready' && row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime() ? 'expired' : row.status;
}

function viewOf(row: ExportRow, now: Date): ExportView {
  const status = statusOf(row, now);
  const scope: ExportScope = row.scope;
  return {
    id: row.id,
    formId: row.formId,
    format: row.format,
    scope: scope.kind === 'selected' ? { kind: 'selected', count: scope.ids.length } : scope.kind === 'filtered' ? { kind: 'filtered', ...(scope.from ? { from: scope.from } : {}), ...(scope.to ? { to: scope.to } : {}) } : { kind: 'all' },
    includeSensitive: row.includeSensitive,
    status,
    rowCount: row.rowCount,
    bytes: row.bytes,
    error: status === 'failed' ? row.error : null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

/**
 * The scope the way it is stored and compared: ids lower-cased, unique and sorted, instants as UTC text. Two requests for
 * the same responses then have the same scope whatever order or spelling the client used, which is what an
 * `Idempotency-Key` replay is checked against.
 */
function normalScope(scope: z.infer<typeof scopeBody>): ExportScope {
  if (scope.kind === 'selected') return { kind: 'selected', ids: [...new Set(scope.ids.map((id) => id.toLowerCase()))].sort() };
  if (scope.kind === 'filtered') {
    return { kind: 'filtered', ...(scope.from ? { from: new Date(scope.from).toISOString() } : {}), ...(scope.to ? { to: new Date(scope.to).toISOString() } : {}) };
  }
  return { kind: 'all' };
}

const scopeKey = (scope: ExportScope): string =>
  scope.kind === 'selected' ? `selected:${scope.ids.join(',')}` : scope.kind === 'filtered' ? `filtered:${scope.from ?? ''}..${scope.to ?? ''}` : 'all';

/** `forms-title-2026-11-16.csv`: letters, digits and hyphens only, so it is safe in a header and on any file system. */
function downloadName(title: string, createdAt: Date, format: ExportRow['format']): string {
  const base = title
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'responses'}-${createdAt.toISOString().slice(0, 10)}.${format}`;
}

const CONTENT_TYPES = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as const satisfies Record<ExportRow['format'], string>;

const UNAVAILABLE = 'Exports are not set up on this server (no object store is configured).';

/**
 * Submissions exports: `POST /v1/forms/:formId/exports` asks for one, `GET /v1/exports/:id` reports on it and
 * `GET /v1/exports/:id/download` streams the finished file (WP-1.17, EXP-01). The file is built by the `export.build` job
 * in the worker; the API only records the request, enqueues the job in the same transaction, and serves the result.
 *
 * Every route is `auth: 'user'` and needs `submissions.export`, so a data viewer is refused (403, audited). Every read and
 * write runs in `withTenant`, so the org is the caller's membership and a form or an export of another org answers 404.
 * An export belongs to the member who asked for it: another member of the same org gets 404 for it too, because the worker
 * redacts the file for its requester (a checker of one review unit must not open the file made for an owner).
 *
 * The file is streamed through the API, not handed over as a presigned URL: a bearer URL could be forwarded, and every
 * download must pass the session check and leave its `export.downloaded` record before the first byte. Without an object
 * store (`deps.storage`) the routes answer 503.
 */
export function exportRoutes(app: FastifyInstance, deps: ExportRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Where the request came from, for the audit records: the session and a keyed hash of the address, never the address. */
  const clientOf = (request: FastifyRequest): ReadClient => {
    const info = clientInfo(request, deps.secret, deps.now());
    return { sessionId: accountOf(request).session?.id ?? null, actorIpHash: hex(info.ipHash), actorUa: info.ua };
  };

  function requireStorage(): Storage {
    if (!deps.storage) throw new ProblemError('SERVICE_UNAVAILABLE', UNAVAILABLE);
    return deps.storage;
  }

  /** The signed-in member an export belongs to: a `user` route always has one; anything else is not a caller of these routes. */
  function requesterOf(tenant: TenantCtx): string {
    if (!tenant.userId) throw new ProblemError('UNAUTHENTICATED');
    return tenant.userId;
  }

  r.post(
    '/v1/forms/:formId/exports',
    {
      config: { auth: 'user', perm: 'submissions.export' },
      schema: {
        tags: ['exports'],
        summary: 'Ask for a CSV or XLSX export of a form\'s responses; the file is built in the background',
        description:
          '`scope` is `{kind:"all"}`, `{kind:"selected", ids}` (1 to 1000 responses) or `{kind:"filtered", from?, to?}` (a received-at range). Encrypted and sensitive fields are masked unless `includeSensitive` is true, which needs a `reason` (422 `EXPORT_REASON_REQUIRED`) that the audit record keeps. ' +
          '`Idempotency-Key` is required (400 without it): a retry with the same key and the same body gets the same export back (`Idempotent-Replayed: true`) and enqueues nothing, the same key for another export is 422 `EXPORT_KEY_REUSED`. ' +
          'At most 10 exports are queued or running per org, and 100 may be asked for in a day: past either, 429 `EXPORT_QUOTA_REACHED` with `Retry-After`. ' +
          'One transaction inserts the row, writes `submission.exported` and enqueues `export.build`. Poll `GET /v1/exports/:id` until `ready`, then download. Without an object store, 503.',
        security: SECURITY,
        params: formParam,
        headers: idempotencyHeaders,
        body: requestBody,
        response: { 200: exportView },
      },
    },
    async (request, reply) => {
      requireStorage();
      const { formId } = request.params;
      const key = request.headers['idempotency-key'];
      const { format, includeSensitive } = request.body;
      const scope = normalScope(request.body.scope);
      const reason = request.body.reason ? request.body.reason : null;
      if (includeSensitive && reason === null) {
        throw new ProblemError('EXPORT_REASON_REQUIRED', 'Say why the export includes sensitive fields: the reason is kept on the audit record.');
      }
      const tenant = tenantOf(request);
      const userId = requesterOf(tenant);
      const client = clientOf(request);
      const now = deps.now();

      const { row, replayed } = await withTenant(deps.db, tenant, async (tx) => {
        // RLS limits this to the caller's org, so a form of another org is as absent as one that never existed.
        const [form] = await tx.select({ id: forms.id }).from(forms).where(eq(forms.id, formId)).limit(1);
        if (!form) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
        if (!deps.queue) throw new ProblemError('SERVICE_UNAVAILABLE', 'Exports cannot be queued on this server.');

        // One export is created at a time per org: without this, ten requests that each saw nine could all insert, and a
        // retry that raced its first attempt would hit the unique key instead of finding it.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`exports:${tenant.orgId}`}, 0))`);

        const [seen] = await tx.select().from(exportJobs).where(and(eq(exportJobs.orgId, tenant.orgId), eq(exportJobs.idempotencyKey, key))).limit(1);
        if (seen) {
          const same =
            seen.requestedBy === userId &&
            seen.formId === formId &&
            seen.format === format &&
            seen.includeSensitive === includeSensitive &&
            (seen.reason ?? null) === reason &&
            scopeKey(seen.scope) === scopeKey(scope);
          if (!same) throw new ProblemError('EXPORT_KEY_REUSED', 'This Idempotency-Key was already used for a different export.');
          return { row: seen, replayed: true };
        }

        const [active] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(exportJobs)
          .where(and(eq(exportJobs.orgId, tenant.orgId), inArray(exportJobs.status, ['queued', 'running']), gt(exportJobs.createdAt, new Date(now.getTime() - ACTIVE_WINDOW_MS))));
        if ((active?.n ?? 0) >= MAX_ACTIVE) {
          reply.header('retry-after', String(BUSY_RETRY_AFTER_SECONDS));
          throw new ProblemError('EXPORT_QUOTA_REACHED', `${MAX_ACTIVE} exports are already being built for this organisation. Try again when one has finished.`);
        }
        const [today] = await tx
          .select({ n: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${exportJobs.createdAt})` })
          .from(exportJobs)
          .where(and(eq(exportJobs.orgId, tenant.orgId), gt(exportJobs.createdAt, new Date(now.getTime() - DAY_MS))));
        if ((today?.n ?? 0) >= MAX_PER_DAY) {
          const oldest = today?.oldest ? new Date(today.oldest).getTime() : now.getTime();
          reply.header('retry-after', String(Math.max(1, Math.ceil((oldest + DAY_MS - now.getTime()) / 1000))));
          throw new ProblemError('EXPORT_QUOTA_REACHED', `${MAX_PER_DAY} exports were asked for in the last 24 hours. Try again later.`);
        }

        const id = randomUUID();
        const [inserted] = await tx
          .insert(exportJobs)
          .values({ id, orgId: tenant.orgId, formId, requestedBy: userId, format, scope, includeSensitive, reason, idempotencyKey: key })
          .returning();
        if (!inserted) throw new Error('the export row was not inserted');
        await auditReads.export(tx, tenant, { formId, exportId: id, format, includeSensitive, reason, client });
        // The job commits with the row (the transactional outbox): an export that is not stored enqueues nothing, and one that is stored has its job.
        const jobId = await deps.queue.send('export.build', { orgId: tenant.orgId, resource: { type: 'export', id }, data: { exportId: id } }, { tx: txExecutor(tx) });
        if (jobId === null) throw new Error('export.build was not enqueued');
        return { row: inserted, replayed: false };
      });
      if (replayed) reply.header('idempotent-replayed', 'true');
      return viewOf(row, now);
    },
  );

  r.get(
    '/v1/exports/:id',
    {
      config: { auth: 'user', perm: 'submissions.export' },
      schema: {
        tags: ['exports'],
        summary: 'The state of an export you asked for: queued, running, ready, failed or expired',
        description:
          'Poll this until `status` is `ready` (then `rowCount`, `bytes` and `expiresAt` are set), `failed` (`error` says why) or `expired`. An export belongs to the member who asked for it: anyone else, in this org or another, gets 404.',
        security: SECURITY,
        params: idParam,
        response: { 200: exportView },
      },
    },
    async (request) => {
      requireStorage();
      const tenant = tenantOf(request);
      const userId = requesterOf(tenant);
      const now = deps.now();
      const row = await withTenant(deps.db, { ...tenant, readOnly: true }, async (tx) => {
        const [found] = await tx
          .select()
          .from(exportJobs)
          .where(and(eq(exportJobs.id, request.params.id), eq(exportJobs.orgId, tenant.orgId), eq(exportJobs.requestedBy, userId)))
          .limit(1);
        return found;
      });
      if (!row) throw new ProblemError('NOT_FOUND', 'That export is not yours in this organisation.');
      return viewOf(row, now);
    },
  );

  r.get(
    '/v1/exports/:id/download',
    {
      config: { auth: 'user', perm: 'submissions.export' },
      schema: {
        tags: ['exports'],
        summary: 'Download a finished export: the file, streamed through the API',
        description:
          'Answers 409 `EXPORT_NOT_READY` while the file is being built and 409 `EXPORT_FAILED` when it failed, 410 `EXPORT_EXPIRED` once its 24 hours are over. Each download is recorded (`export.downloaded`) before the first byte is sent. ' +
          'There is no presigned URL: the bytes come through here, after the session and the audit record.',
        security: SECURITY,
        params: idParam,
      },
    },
    async (request, reply) => {
      const storage = requireStorage();
      const tenant = tenantOf(request);
      const userId = requesterOf(tenant);
      const client = clientOf(request);
      const now = deps.now();
      // Not read-only: a download is recorded on the org's audit chain in the transaction that checked it.
      const found = await withTenant(deps.db, tenant, async (tx) => {
        const [row] = await tx
          .select()
          .from(exportJobs)
          .where(and(eq(exportJobs.id, request.params.id), eq(exportJobs.orgId, tenant.orgId), eq(exportJobs.requestedBy, userId)))
          .limit(1);
        if (!row) throw new ProblemError('NOT_FOUND', 'That export is not yours in this organisation.');
        const status = statusOf(row, now);
        if (status === 'queued' || status === 'running') throw new ProblemError('EXPORT_NOT_READY', 'The file is still being built. Check the export again in a moment.');
        if (status === 'failed') throw new ProblemError('EXPORT_FAILED', 'The export failed, so there is no file. Ask for a new one.');
        if (status === 'expired') throw new ProblemError('EXPORT_EXPIRED', 'The file was kept for 24 hours and is gone. Ask for a new export.');
        // The key is the worker's to write, `<orgId>/<exportId>.<ext>`; a row that names another org's prefix is corrupt, and is never streamed.
        if (!row.objectKey || !row.objectKey.startsWith(`${tenant.orgId}/`)) {
          request.log.error({ exportId: row.id }, 'a ready export has no object key of its own org');
          throw new ProblemError('INTERNAL');
        }
        const head = await storage.head('exports', row.objectKey);
        if (!head) throw new ProblemError('EXPORT_EXPIRED', 'The file is no longer stored. Ask for a new export.');
        const [form] = await tx.select({ title: forms.title }).from(forms).where(eq(forms.id, row.formId)).limit(1);
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: client.sessionId ?? null,
          actorIpHash: client.actorIpHash ?? null,
          actorUa: client.actorUa ?? null,
          action: 'export.downloaded',
          resourceType: 'export',
          resourceId: row.id,
          formId: row.formId,
          outcome: 'success',
          metadata: { format: row.format, bytes: head.bytes },
        });
        return { row, objectKey: row.objectKey, bytes: head.bytes, title: form?.title ?? '' };
      });
      let body: ByteStream;
      try {
        body = await storage.get('exports', found.objectKey);
      } catch (err) {
        // Removed between the check and the read (the 24 hour sweep): the same answer as an expired file.
        if (isPortError(err, 'not_found')) throw new ProblemError('EXPORT_EXPIRED', 'The file is no longer stored. Ask for a new export.');
        throw err;
      }
      return reply
        .header('content-type', CONTENT_TYPES[found.row.format])
        .header('content-disposition', attachmentHeader(downloadName(found.title, found.row.createdAt, found.row.format)))
        .header('content-length', found.bytes)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store')
        .send(Readable.from(body));
    },
  );
}
