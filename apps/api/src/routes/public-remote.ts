import { createHash } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { resolveFormSlug, withTenant, type Db, type ResolvedFormSlug } from '@form/db';
import { evaluateCheck, mapApiOptions, projectLookupRows } from '@form/logic';
import type { OrgSecrets } from '@form/ports';
import { clientInfo } from '../auth.ts';
import type { ApiConfig } from '../config.ts';
import { ProblemError } from '../errors.ts';
import type { Throttle, ThrottleKey } from '../modules/auth/throttle.ts';
import { LOOKUP_TTL_MS, OPTIONS_TTL_MS, TtlCache } from '../remote/cache.ts';
import { FormConcurrency } from '../remote/concurrency.ts';
import { lookupCacheKey, OPTION_LIMITS, publicOptions } from '../remote/project.ts';
import { findFieldCheck, findFieldOptions, findHttpLookup } from '../remote/targets.ts';
import { callUpstream, UpstreamError, type TenantHttp } from '../remote/upstream.ts';
import { runtimeStatus } from '../runtime/status.ts';
import { assertOpen, isUnlocked, readAccess } from '../submit/access.ts';
import type { VersionLoader } from '../submit/live.ts';
import { isPreviousVersionAccepted, readNamedVersionState } from '../submit/versions.ts';

export interface PublicRemoteDeps {
  db: Db;
  config: ApiConfig;
  throttle: Throttle;
  /** The version loader the other public routes share (a version never changes, so one cache serves them all). */
  loader: VersionLoader;
  /** One request to an address a form's owner chose, through the tenant egress guard (`main.ts`); without it the proxy answers 503. */
  tenantHttp?: TenantHttp | undefined;
  orgSecrets?: OrgSecrets | undefined;
  now: () => Date;
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const OPAQUE = /^[A-Za-z0-9_-]{1,64}$/;
const TAGS = ['runtime'];
/** The one answer to every upstream failure, whatever its cause: the proxy is no DNS, host or path oracle. */
const UPSTREAM_FAILED = 'The lookup source did not answer.';

const cells = z.record(z.string().max(128), z.string().max(1000));
const lookupResponse = z.object({ rows: z.array(z.object({ label: z.string().max(200), cells })).max(50), truncated: z.boolean() });
const optionsResponse = z.object({ options: z.array(z.object({ id: z.string().max(OPTION_LIMITS.id), label: z.string().max(OPTION_LIMITS.label), code: z.string().max(OPTION_LIMITS.id).exactOptional() })).max(OPTION_LIMITS.count) });
const checkResponse = z.object({ ok: z.boolean() });


/**
 * The respondent's door to third-party APIs a form uses (founder, 25 Nov 2026): `POST /v1/p/:slug/lookups/:lookupId`,
 * `/fields/:blockId/options` and `/fields/:blockId/check`. The browser sends only an id and what the respondent typed;
 * the URL, query, body, keys and credential come from the version's stored definition, and the server decides what of the
 * answer the respondent may see (declared cells only, capped). Public, with no session, so it is built for `curl`:
 *
 * - Before the body is read: the address's budget over every form (`auth_remote_ip`), the slug (404), then the budget of the
 *   address on this form (`auth_remote_form`) and of every address on it (`auth_remote_formall`). 429 with `Retry-After`.
 *   These buckets are separate from submit and upload, so spending them never blocks a submission.
 * - The named version is accepted as submit accepts it (live, or previous within the window), the form must be open for that
 *   version (`FORM_CLOSED`, `LIMIT_REACHED`, `PASSWORD_REQUIRED` with the token scoped to that version), and the target must
 *   be in THAT version's stored definition, enabled (404 `REMOTE_NOT_FOUND` otherwise).
 * - Strict bodies: an extra key (url, itemsPath, headers, ...) is 400.
 * - One fixed 502 for every upstream failure; the host and the reason go to the log, never the search term, the value, the
 *   rows, the path, the query or a credential.
 */
export function publicRemoteRoutes(app: FastifyInstance, deps: PublicRemoteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const lookupCache = new TtlCache<z.infer<typeof lookupResponse>>();
  const optionsCache = new TtlCache<z.infer<typeof optionsResponse>>();
  const concurrency = new FormConcurrency(4);
  const admitted = new WeakMap<FastifyRequest, ResolvedFormSlug>();

  async function admit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { ipHash } = clientInfo(request, deps.config.auth.secret, deps.now());
      const tooMany = 'Too many requests from this address. Try again later.';
      await deps.throttle.hit(request, reply, [{ bucket: 'auth_remote_ip', key: ipHash }], { ipHash }, tooMany);
      const slug = (request.params as { slug?: unknown }).slug;
      if (typeof slug !== 'string' || !SLUG.test(slug)) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      const found = await resolveFormSlug(deps.db, slug);
      if (!found) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      const perForm: ThrottleKey = { bucket: 'auth_remote_form', key: new Uint8Array(createHash('sha256').update(ipHash).update(found.formId).digest().subarray(0, 16)) };
      const forAll: ThrottleKey = { bucket: 'auth_remote_formall', key: new Uint8Array(createHash('sha256').update('remote-form').update(found.formId).digest().subarray(0, 16)) };
      await deps.throttle.hit(request, reply, [perForm, forAll], { ipHash }, tooMany);
      admitted.set(request, found);
    } catch (err) {
      reply.header('connection', 'close');
      throw err;
    }
  }

  /** Steps 4 and 5 of the contract: the version the respondent may use, and whether the form is open for it. */
  async function version(request: FastifyRequest, formVersionId: string) {
    const found = admitted.get(request);
    if (!found) throw new ProblemError('NOT_FOUND', 'This form is not published.');
    const now = deps.now();
    const isLive = formVersionId === found.liveVersionId;
    const seen = await withTenant(deps.db, { orgId: found.orgId, actor: 'respondent', requestId: request.id, readOnly: true }, async (tx) => ({
      ...(await readAccess(tx, found.formId)),
      named: isLive ? null : await readNamedVersionState(tx, found.formId, formVersionId),
    }));
    const superseded = () => new ProblemError('VERSION_SUPERSEDED', 'This form was updated while you were filling it. Reload and try again.');
    if (!isLive && !isPreviousVersionAccepted(seen.named, seen.access.acceptPreviousVersionsHours, now)) throw superseded();
    const loaded = await deps.loader.get(found, formVersionId, request.id);
    if (!loaded) throw superseded();
    const token = typeof request.headers['x-fr-access'] === 'string' ? request.headers['x-fr-access'] : undefined;
    const unlocked = isUnlocked(deps.config.auth.secret, seen.access, token, { formId: found.formId, versionScope: formVersionId }, now);
    assertOpen(runtimeStatus(seen.access, { submittedTotal: seen.submittedTotal }, now, { unlocked }));
    return { found, loaded };
  }

  /** Runs one upstream call under the form's in-flight cap and turns every failure into the one fixed problem. */
  async function upstream<T>(request: FastifyRequest, reply: FastifyReply, formId: string, call: () => Promise<T>): Promise<T> {
    if (!deps.tenantHttp) throw new ProblemError('REMOTE_UNAVAILABLE', 'Lookups are not available.');
    try {
      const out = await concurrency.run(formId, call);
      if (!out.ran) {
        reply.header('retry-after', '1');
        throw new ProblemError('REMOTE_BUSY', 'Too many lookups at once. Try again in a moment.');
      }
      return out.value;
    } catch (err) {
      if (err instanceof UpstreamError) {
        // The host and the reason only: no search term, value, row, path, query or credential.
        (request.log as FastifyBaseLogger).warn({ formId, host: err.host, reason: err.reason }, 'remote upstream failed');
        throw new ProblemError('REMOTE_UPSTREAM_FAILED', UPSTREAM_FAILED);
      }
      throw err;
    }
  }

  const common = {
    config: { auth: 'none' as const },
    preParsing: async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
      await admit(request, reply);
      return payload as never;
    },
  };
  const notFound = () => new ProblemError('REMOTE_NOT_FOUND', 'No such lookup.');
  const upstreamDeps = () => ({ db: deps.db, tenantHttp: deps.tenantHttp as TenantHttp, orgSecrets: deps.orgSecrets });

  r.post(
    '/v1/p/:slug/lookups/:lookupId',
    {
      ...common,
      schema: {
        tags: TAGS,
        summary: "Search a form's lookup",
        description:
          'The respondent names a lookup of the version their page was built from and types a search term; the server calls the lookup\'s API from the stored configuration and returns at most `maxRows` rows holding only the declared cells. `q` is at most 100 characters; unknown body keys are 400. Same access rules as submit (`X-FR-Access` for a password form). Every upstream failure is one 502 `REMOTE_UPSTREAM_FAILED`.',
        params: z.object({ slug: z.string().regex(SLUG), lookupId: z.string().regex(OPAQUE) }),
        body: z.strictObject({ formVersionId: z.uuid(), q: z.string().max(100) }),
        response: { 200: lookupResponse },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const { found, loaded } = await version(request, request.body.formVersionId);
      const def = loaded.definition;
      const lookup = findHttpLookup(def, request.params.lookupId);
      if (!lookup) throw notFound();
      const q = request.body.q;
      const minChars = lookup.minChars ?? 2;
      if (q.trim().length < minChars) return { rows: [], truncated: false };
      const now = deps.now().getTime();
      const key = lookupCacheKey(loaded.versionId, request.params.lookupId, q, lookup.searchParam);
      const hit = lookupCache.get(key, now);
      if (hit) return hit;
      const extra = lookup.searchParam !== undefined ? { key: lookup.searchParam, value: q } : undefined;
      const { data } = await upstream(request, reply, found.formId, () => callUpstream(upstreamDeps(), { orgId: found.orgId, config: lookup, extra }));
      const projected = projectLookupRows(data, lookup, { q, hasBlock: (id) => def.blocks[id as keyof typeof def.blocks] !== undefined });
      lookupCache.set(key, projected, now, LOOKUP_TTL_MS);
      return projected;
    },
  );

  r.post(
    '/v1/p/:slug/fields/:blockId/options',
    {
      ...common,
      schema: {
        tags: TAGS,
        summary: "Load a field's option list from its API",
        description: 'At most 500 options (ids and codes clipped to 200 characters, labels to 500), cached for 60 seconds per version and field. Same access rules and errors as the lookup route.',
        params: z.object({ slug: z.string().regex(SLUG), blockId: z.string().regex(OPAQUE) }),
        body: z.strictObject({ formVersionId: z.uuid() }),
        response: { 200: optionsResponse },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const { found, loaded } = await version(request, request.body.formVersionId);
      const target = findFieldOptions(loaded.definition, request.params.blockId);
      if (!target || target.config.itemsPath === undefined) throw notFound();
      const now = deps.now().getTime();
      const key = `${loaded.versionId}|${request.params.blockId}`;
      const hit = optionsCache.get(key, now);
      if (hit) return hit;
      const { data } = await upstream(request, reply, found.formId, () => callUpstream(upstreamDeps(), { orgId: found.orgId, config: target.config }));
      const options = publicOptions(mapApiOptions(data, target.config));
      const body = { options };
      optionsCache.set(key, body, now, OPTIONS_TTL_MS);
      return body;
    },
  );

  r.post(
    '/v1/p/:slug/fields/:blockId/check',
    {
      ...common,
      schema: {
        tags: TAGS,
        summary: "Check a field's value against its API",
        description: 'Answers only `{ ok }`; the upstream body is never returned and the answer is never cached.',
        params: z.object({ slug: z.string().regex(SLUG), blockId: z.string().regex(OPAQUE) }),
        body: z.strictObject({ formVersionId: z.uuid(), value: z.union([z.string().max(1000), z.number().finite(), z.boolean()]) }),
        response: { 200: checkResponse },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const { found, loaded } = await version(request, request.body.formVersionId);
      const target = findFieldCheck(loaded.definition, request.params.blockId);
      if (!target) throw notFound();
      const { data } = await upstream(request, reply, found.formId, () =>
        callUpstream(upstreamDeps(), { orgId: found.orgId, config: target.config, extra: { key: target.key, value: request.body.value }, allowEmpty: true }),
      );
      return { ok: evaluateCheck(data, target.config) };
    },
  );
}
