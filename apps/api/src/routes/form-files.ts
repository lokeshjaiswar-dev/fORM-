import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audit, auditActor, formFiles, withTenant, type Db } from '@form/db';
import { z } from 'zod';
import { accountOf, clientInfo, tenantOf } from '../auth.ts';
import { ProblemError } from '../errors.ts';
import { attachmentHeader, downloadContentType, type FileStore } from '../files.ts';
import { hex } from '../modules/auth/crypto.ts';

/**
 * Files respondents uploaded to a form (`POST /v1/p/:slug/files`), read back by members of the owning org only:
 * a session, the `submissions.read` permission, and the `form_files` row visible under row-level security, so a
 * member of another org gets the same 404 as for a file that does not exist. The bytes always come down as an
 * attachment: as `application/octet-stream`, unless they are one of the four image types, and never sniffed, so a file
 * can never run as a page on the API's origin.
 */
export function formFileRoutes(app: FastifyInstance, deps: { db: Db; files: FileStore; secret: Uint8Array; now: () => Date }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/forms/:formId/files/:id',
    {
      config: { auth: 'user', perm: 'submissions.read' },
      schema: {
        tags: ['submissions'],
        summary: 'Download a file a respondent uploaded to this form',
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
        params: z.object({ formId: z.uuid(), id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const { formId, id } = request.params;
      const tenant = tenantOf(request);
      const cl = clientInfo(request, deps.secret, deps.now());
      // Not read-only: opening a respondent's file is recorded on the org's audit chain.
      const row = await withTenant(deps.db, tenant, async (tx) => {
        const [found] = await tx
          .select({ id: formFiles.id, name: formFiles.name, mime: formFiles.mime, sizeBytes: formFiles.sizeBytes })
          .from(formFiles)
          .where(and(eq(formFiles.id, id), eq(formFiles.formId, formId)))
          .limit(1);
        if (!found) return null;
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: accountOf(request).session?.id ?? null,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'file.downloaded',
          resourceType: 'file',
          resourceId: id,
          formId,
          outcome: 'success',
        });
        return found;
      });
      if (!row) throw new ProblemError('NOT_FOUND', 'That file is not on this form.');
      const bytes = await deps.files.get(row.id);
      if (!bytes) throw new ProblemError('NOT_FOUND', 'That file is no longer stored.');
      return reply
        .header('content-type', downloadContentType(row.mime))
        .header('content-disposition', attachmentHeader(row.name))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store')
        .header('content-length', bytes.length)
        .send(bytes);
    },
  );
}
