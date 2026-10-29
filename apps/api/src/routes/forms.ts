import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { FORM_LIFECYCLES, forms, withTenant, type Db } from '@form/db';
import { z } from 'zod';
import { tenantOf } from '../auth.ts';

export const formSummary = z.object({
  id: z.uuid(),
  title: z.string(),
  lifecycle: z.enum(FORM_LIFECYCLES),
  teamId: z.uuid(),
  updatedAt: z.iso.datetime({ offset: true }),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  lifecycle: z.enum(FORM_LIFECYCLES).default('active'),
});

/** `GET /v1/forms`: the RLS demonstration. The query names no org; the database returns only the caller's. */
export function formRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/forms',
    {
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags: ['forms'],
        summary: 'List forms in the active org',
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
        querystring: listQuery,
        response: { 200: z.object({ items: z.array(formSummary) }) },
      },
    },
    async (request) => {
      const { limit, lifecycle } = request.query;
      const rows = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, (tx) =>
        tx
          .select({ id: forms.id, title: forms.title, lifecycle: forms.lifecycle, teamId: forms.teamId, updatedAt: forms.updatedAt })
          .from(forms)
          .where(eq(forms.lifecycle, lifecycle))
          .orderBy(desc(forms.updatedAt), desc(forms.id))
          .limit(limit),
      );
      return { items: rows.map((f) => ({ ...f, updatedAt: f.updatedAt.toISOString() })) };
    },
  );
}
