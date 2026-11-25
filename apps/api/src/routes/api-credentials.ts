import { asc, eq, and } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, auditActor, secretPublicColumns, secrets, withTenant, type Db } from '@form/db';
import type { OrgSecrets } from '@form/ports';
import { ApiAuthSchema, type ApiAuth } from '@form/schema';
import { accountOf, clientInfo, tenantOf } from '../auth.ts';
import { ProblemError } from '../errors.ts';
import { hex } from '../modules/auth/crypto.ts';
import { isAllowedApiKeyHeader } from '../remote/upstream.ts';
import { uuidv7 } from '../uuid7.ts';

export interface ApiCredentialRouteDeps {
  db: Db;
  auditDb: Db;
  /** Seals the credential under the org's key context (`orgSecrets.seal`, kind `api_credential`); without it the writes answer 503. */
  orgSecrets?: OrgSecrets | undefined;
  secret: Uint8Array;
  now: () => Date;
}

const SECURITY = [{ session: [], org: [] }, { devUser: [], org: [] }];
const TAGS = ['api-credentials'];
const isoInstant = z.iso.datetime({ offset: true });
const idParam = z.object({ id: z.uuid() });
// eslint-disable-next-line no-control-regex
const PLAIN_NAME = /^[^\u0000-\u001f\u007f<>]*$/;
const nameField = z.string().trim().min(1).max(120).regex(PLAIN_NAME, 'must not contain control characters or angle brackets');
const hostField = z.string().trim().min(1).max(260);
/** `Type` of an ApiAuth, which an api_key's header name must also pass (never a framing or identity header). */
const authField = ApiAuthSchema.refine((a) => a.type !== 'api_key' || isAllowedApiKeyHeader(a.header), { message: 'that header name is not allowed for an API key' });

const createBody = z.strictObject({ name: nameField, host: hostField, auth: authField });
const putBody = z
  .strictObject({ name: nameField, host: hostField, auth: authField })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'send at least one field to change');

const view = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(['bearer', 'api_key', 'basic']),
  /** The header name of an `api_key` credential. */
  header: z.string().nullable(),
  host: z.string(),
  /** The last four characters of the secret, empty when it is too short to show any. */
  last4: z.string(),
  createdAt: isoInstant,
  rotatedAt: isoInstant.nullable(),
});
type View = z.infer<typeof view>;

/**
 * `host[:port]` as the proxy compares it: lower case, no scheme, path or user info, the default https port dropped. A value
 * that is not exactly a host (and maybe a port) is null. The credential is sent only to this host, only over https.
 */
export function normaliseHost(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f/?#@\\]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(`https://${raw}`);
  } catch {
    return null;
  }
  if (url.hostname === '' || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return url.host.toLowerCase();
}

/** The secret value of an ApiAuth, whose tail is the only part of it that is ever shown. */
function secretOf(auth: ApiAuth): string {
  return auth.type === 'bearer' ? auth.token : auth.type === 'api_key' ? auth.value : auth.password;
}

/** Shown to recognise a credential, never to reconstruct one: nothing is shown of a short secret. */
const last4Of = (secret: string) => (secret.length >= 12 ? secret.slice(-4) : '');

function metaOf(name: string, host: string, auth: ApiAuth): Record<string, unknown> {
  return { name, type: auth.type, ...(auth.type === 'api_key' ? { header: auth.header } : {}), host, last4: last4Of(secretOf(auth)) };
}

type Row = { id: string; meta: Record<string, unknown>; createdAt: Date; rotatedAt: Date | null };

function viewOf(row: Row): View {
  const m = row.meta;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const type = m['type'] === 'api_key' || m['type'] === 'basic' ? m['type'] : 'bearer';
  return {
    id: row.id,
    name: str(m['name']),
    type,
    header: typeof m['header'] === 'string' ? m['header'] : null,
    host: str(m['host']),
    last4: str(m['last4']),
    createdAt: row.createdAt.toISOString(),
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
  };
}

/**
 * The org's API credentials: `/v1/org/api-credentials` (server-side lookups). A credential is a `secrets` row of kind
 * `api_credential`: the sealed `ApiAuth` (bearer, api_key or basic) in `enc`, write-only, and in `meta` what a screen may
 * show: name, type, header name, the host it is bound to and the last four characters of the secret. A form's lookup, option
 * list or check names it by id; the proxy sends it only over https to exactly that host, so an author with `forms.edit` can pick
 * a credential but can never aim it at a server of their own.
 *
 * Writing needs `org.settings` (and the row's own RLS says the same). Listing needs `org.settings` or `forms.edit` (an author
 * has to pick one) and returns the public columns only. Every write is audited by id and changed keys, never a value.
 */
export function apiCredentialRoutes(app: FastifyInstance, deps: ApiCredentialRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const client = (request: FastifyRequest) => {
    const info = clientInfo(request, deps.secret, deps.now());
    return { sessionId: accountOf(request).session?.id ?? null, actorIpHash: hex(info.ipHash), actorUa: info.ua };
  };
  const sealer = () => {
    if (!deps.orgSecrets) throw new ProblemError('SERVICE_UNAVAILABLE', 'API credentials need the key service, which is not configured.');
    return deps.orgSecrets;
  };
  const columns = { ...secretPublicColumns };

  r.get(
    '/v1/org/api-credentials',
    {
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags: TAGS,
        summary: "List the org's API credentials",
        description: 'For a caller with `org.settings` or `forms.edit` (an author picks one for a lookup). Public columns only: the secret is never returned, to anyone.',
        security: SECURITY,
        response: { 200: z.object({ items: z.array(view) }) },
      },
    },
    async (request, reply) => {
      const perms = tenantOf(request).perms ?? [];
      if (!perms.includes('org.settings') && !perms.includes('forms.edit')) throw new ProblemError('FORBIDDEN', 'Requires org.settings or forms.edit.');
      const rows = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, (tx) =>
        tx.select(columns).from(secrets).where(eq(secrets.kind, 'api_credential')).orderBy(asc(secrets.createdAt), asc(secrets.id)),
      );
      reply.header('cache-control', 'private, no-store');
      return { items: rows.map(viewOf) };
    },
  );

  r.post(
    '/v1/org/api-credentials',
    {
      config: { auth: 'user', perm: 'org.settings' },
      schema: {
        tags: TAGS,
        summary: 'Add an API credential',
        description:
          'Seals the credential under the org\'s key and never returns it. `host` is `host` or `host:port` (no scheme or path): the credential is sent only over https to exactly that host. An `api_key` header may not be `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Cookie`, `Set-Cookie`, `Forwarded`, `Proxy-*` or `X-Forwarded-*`. Without the key service the answer is 503. Audited as `api_credential.saved`, never the value.',
        security: SECURITY,
        body: createBody,
        response: { 201: view },
      },
    },
    async (request, reply) => {
      const orgSecrets = sealer();
      const tenant = tenantOf(request);
      const body = request.body;
      const host = normaliseHost(body.host);
      if (!host) throw new ProblemError('BAD_REQUEST', 'The host must be a host name and an optional port, for example api.example.com.');
      const who = client(request);
      const id = uuidv7();
      const enc = await orgSecrets.seal({ orgId: tenant.orgId, secretId: id, kind: 'api_credential' }, JSON.stringify(body.auth));
      const created = await withTenant(deps.db, tenant, async (tx) => {
        await tx.insert(secrets).values({ id, orgId: tenant.orgId, kind: 'api_credential', enc: enc as unknown as Record<string, unknown>, meta: metaOf(body.name, host, body.auth) });
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          ...who,
          action: 'api_credential.saved',
          resourceType: 'api_credential',
          resourceId: id,
          outcome: 'success',
          metadata: { change: 'created', changedKeys: ['name', 'host', 'auth'], authType: body.auth.type },
        });
        const [row] = await tx.select(columns).from(secrets).where(eq(secrets.id, id)).limit(1);
        return row!;
      });
      return reply.code(201).send(viewOf(created));
    },
  );

  r.put(
    '/v1/org/api-credentials/:id',
    {
      config: { auth: 'user', perm: 'org.settings' },
      schema: {
        tags: TAGS,
        summary: 'Rename, re-bind or rotate an API credential',
        description: 'Any of `name`, `host` and `auth`. A new `auth` seals the new secret in place (the id stays, so forms keep working) and sets `rotatedAt`. Audited as `api_credential.saved`, never the value.',
        security: SECURITY,
        params: idParam,
        body: putBody,
        response: { 200: view },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      const { id } = request.params;
      const body = request.body;
      const who = client(request);
      let host: string | undefined;
      if (body.host !== undefined) {
        const h = normaliseHost(body.host);
        if (!h) throw new ProblemError('BAD_REQUEST', 'The host must be a host name and an optional port, for example api.example.com.');
        host = h;
      }
      const enc = body.auth !== undefined ? await sealer().seal({ orgId: tenant.orgId, secretId: id, kind: 'api_credential' }, JSON.stringify(body.auth)) : undefined;
      const now = deps.now();
      return withTenant(deps.db, tenant, async (tx) => {
        const [before] = await tx.select(columns).from(secrets).where(and(eq(secrets.id, id), eq(secrets.kind, 'api_credential'))).limit(1).for('update');
        if (!before) throw new ProblemError('NOT_FOUND', 'That API credential is not in this organisation.');
        const m = before.meta;
        const name = body.name ?? (typeof m['name'] === 'string' ? m['name'] : '');
        const boundHost = host ?? (typeof m['host'] === 'string' ? m['host'] : '');
        // Without a new secret the type, header and last characters stay as they were.
        const meta = body.auth ? metaOf(name, boundHost, body.auth) : { ...m, name, host: boundHost };
        const changedKeys = [...(body.name !== undefined ? ['name'] : []), ...(host !== undefined ? ['host'] : []), ...(body.auth ? ['auth'] : [])];
        await tx
          .update(secrets)
          .set({ meta, ...(enc ? { enc: enc as unknown as Record<string, unknown>, rotatedAt: now } : {}) })
          .where(and(eq(secrets.id, id), eq(secrets.kind, 'api_credential')));
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          ...who,
          action: 'api_credential.saved',
          resourceType: 'api_credential',
          resourceId: id,
          outcome: 'success',
          metadata: { change: body.auth ? 'rotated' : 'updated', changedKeys },
        });
        const [row] = await tx.select(columns).from(secrets).where(eq(secrets.id, id)).limit(1);
        return viewOf(row!);
      });
    },
  );

  r.delete(
    '/v1/org/api-credentials/:id',
    {
      config: { auth: 'user', perm: 'org.settings' },
      schema: {
        tags: TAGS,
        summary: 'Delete an API credential',
        description: 'A lookup, option list or check that still names it then fails with the fixed 502 until another credential is chosen.',
        security: SECURITY,
        params: idParam,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      const { id } = request.params;
      const who = client(request);
      await withTenant(deps.db, tenant, async (tx) => {
        const gone = await tx.delete(secrets).where(and(eq(secrets.id, id), eq(secrets.kind, 'api_credential'))).returning({ id: secrets.id });
        if (gone.length === 0) throw new ProblemError('NOT_FOUND', 'That API credential is not in this organisation.');
        await audit.append(tx, tenant.orgId, { ...auditActor(tenant), ...who, action: 'api_credential.deleted', resourceType: 'api_credential', resourceId: id, outcome: 'success' });
      });
      return reply.code(204).send(null);
    },
  );
}
