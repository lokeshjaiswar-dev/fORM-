import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { forms, withTenant, type Db } from '@form/db';
import type { OrgSecrets } from '@form/ports';
import { ApiPairSchema, CredentialRefSchema, SafeUrlSchema } from '@form/schema';
import { clientInfo, tenantOf } from '../auth.ts';
import { ProblemError } from '../errors.ts';
import type { Throttle } from '../modules/auth/throttle.ts';
import { callUpstream, UpstreamError, type TenantHttp } from '../remote/upstream.ts';

export interface RemoteTestDeps {
  db: Db;
  throttle: Throttle;
  tenantHttp?: TenantHttp | undefined;
  orgSecrets?: OrgSecrets | undefined;
  secret: Uint8Array;
  now: () => Date;
}

const SECURITY = [{ session: [], org: [] }, { devUser: [], org: [] }];
export const TEST_MAX_BYTES = 256 * 1024;
export const TEST_MAX_ITEMS = 50;
const MAX_STRING = 2000;
const MAX_DEPTH = 16;

/** Cuts a parsed tree to what an author needs to pick paths from: at most `items` entries per array, long strings clipped, depth bounded. */
export function truncateTree(value: unknown, items: number, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, items).map((v) => truncateTree(v, items, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 200).map(([k, v]) => [k, truncateTree(v, items, depth + 1)]));
}

/** The tree an author sees: arrays of at most 50, and the whole of it under 256 KiB (halving the arrays until it fits). */
export function authorView(data: unknown): { data: unknown; truncated: boolean } {
  let items = TEST_MAX_ITEMS;
  let tree = truncateTree(data, items);
  let truncated = JSON.stringify(tree) !== JSON.stringify(data);
  while (JSON.stringify(tree).length > TEST_MAX_BYTES && items > 1) {
    items = Math.max(1, Math.floor(items / 2));
    tree = truncateTree(data, items);
    truncated = true;
  }
  return JSON.stringify(tree).length > TEST_MAX_BYTES ? { data: null, truncated: true } : { data: tree, truncated };
}

const requestBody = z.strictObject({
  url: SafeUrlSchema,
  method: z.enum(['GET', 'POST']).exactOptional(),
  query: z.array(ApiPairSchema).max(32).exactOptional(),
  body: z.array(ApiPairSchema).max(32).exactOptional(),
  parser: z.enum(['json', 'xml']).exactOptional(),
  credentialRef: CredentialRefSchema.exactOptional(),
  searchParam: z.string().min(1).max(64).exactOptional(),
});

/**
 * `POST /v1/forms/:formId/remote/test` (server-side lookups): the builder's Test buttons and the builder preview call the
 * author's API through the server, because the browser no longer may (the production CSP allows no third-party origin) and
 * because a credential must stay on the server. It needs `forms.edit`, a form of the caller's org (another org's is a 404),
 * and goes through the same egress guard, host-bound credential and caps as the respondent's proxy. The author sees the parsed
 * answer, cut to 50 entries per array and 256 KiB; a failure is the same fixed 502. Counted per user (`auth_remote_test`).
 */
export function remoteTestRoutes(app: FastifyInstance, deps: RemoteTestDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/v1/forms/:formId/remote/test',
    {
      config: { auth: 'user', perm: 'forms.edit' },
      schema: {
        tags: ['remote'],
        summary: "Call a form's lookup, option list or check API as the author",
        description:
          'Sends the configured request once through the server (egress guard, host-bound credential, 5 s, 1 MiB) and returns the parsed answer cut to 50 entries per array and 256 KiB. `q` is the search term (sent under `request.searchParam`); `fieldKey` and `value` are a field check\'s value. Any failure to reach or read the API is 502 `REMOTE_UPSTREAM_FAILED`. 120 calls per 10 minutes per user.',
        security: SECURITY,
        params: z.object({ formId: z.uuid() }),
        body: z.strictObject({
          request: requestBody,
          q: z.string().max(100).exactOptional(),
          fieldKey: z.string().min(1).max(128).exactOptional(),
          value: z.union([z.string().max(1000), z.number().finite(), z.boolean()]).exactOptional(),
        }),
        response: { 200: z.object({ status: z.number().int(), data: z.unknown(), truncated: z.boolean() }) },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const tenant = tenantOf(request);
      const { ipHash } = clientInfo(request, deps.secret, deps.now());
      const userKey = new Uint8Array(createHash('sha256').update('remote-test').update(tenant.userId ?? '').digest().subarray(0, 16));
      await deps.throttle.hit(request, reply, [{ bucket: 'auth_remote_test', key: userKey }], { ipHash, userId: tenant.userId ?? null }, 'Too many test calls. Try again later.');
      // The form must be one of the caller's org: row-level security makes another org's form not exist.
      const [form] = await withTenant(deps.db, { ...tenant, readOnly: true }, (tx) => tx.select({ id: forms.id }).from(forms).where(eq(forms.id, request.params.formId)).limit(1));
      if (!form) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
      if (!deps.tenantHttp) throw new ProblemError('REMOTE_UNAVAILABLE', 'Lookups are not available.');
      const { request: config, q, fieldKey, value } = request.body;
      const { searchParam, ...upstreamConfig } = config;
      const extra = fieldKey !== undefined && value !== undefined ? { key: fieldKey, value } : searchParam !== undefined && q !== undefined ? { key: searchParam, value: q } : undefined;
      try {
        const { data, status } = await callUpstream({ db: deps.db, tenantHttp: deps.tenantHttp, orgSecrets: deps.orgSecrets }, { orgId: tenant.orgId, config: upstreamConfig, extra, allowEmpty: true });
        return { status, ...authorView(data) };
      } catch (err) {
        if (err instanceof UpstreamError) {
          request.log.warn({ formId: request.params.formId, host: err.host, reason: err.reason }, 'remote author test failed');
          throw new ProblemError('REMOTE_UPSTREAM_FAILED', 'The lookup source did not answer.');
        }
        throw err;
      }
    },
  );
}
