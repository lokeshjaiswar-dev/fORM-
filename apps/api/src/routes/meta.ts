import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { editionSummary, editionSummarySchema, type EditionConfig } from '@form/config';

/**
 * `GET /v1/meta/edition`: what this deployment can run (FND-19), for the builder's palette, gallery and sign-in page,
 * so it needs no session. Per-org features (plan or licence, org restrictions) come from `GET /v1/meta/features`.
 */
export function metaRoutes(app: FastifyInstance, deps: { edition: EditionConfig }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const body = editionSummary(deps.edition);

  r.get(
    '/v1/meta/edition',
    {
      config: { auth: 'none' },
      schema: { tags: ['meta'], summary: 'Edition of this deployment', response: { 200: editionSummarySchema } },
    },
    async (_request, reply) => {
      reply.header('cache-control', 'public, max-age=60');
      return body;
    },
  );
}
