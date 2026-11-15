import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { EditionConfig } from '@form/config';
import {
  audit,
  auditActor,
  DELIVERY_STATUSES,
  formDrafts,
  forms,
  isUuid,
  secrets,
  txExecutor,
  WEBHOOK_EVENTS,
  webhookDeliveries,
  webhooks,
  withTenant,
  type Db,
  type Tx,
} from '@form/db';
import { isPortError, type EgressGuard, type OrgSecrets, type Queue } from '@form/ports';
import { FieldKeySchema, PurposeIdSchema, WebhookConfigSchema } from '@form/schema';
import { accountOf, clientInfo, tenantOf } from '../auth.ts';
import { MAX_CURSOR_LENGTH, readCursor, signCursor } from '../cursor.ts';
import { ProblemError } from '../errors.ts';
import { hex } from '../modules/auth/crypto.ts';
import { uuidv7 } from '../uuid7.ts';

export interface WebhookRouteDeps {
  /** The request pool: every read and write goes through `withTenant` on it, so row-level security limits it to the caller's org. */
  db: Db;
  /** The small separate pool for denied and failed audit records (ADR-0006). */
  auditDb: Db;
  /**
   * Seals the signing secret under the org's key context (`orgSecrets.seal`, kind `webhook_hmac`); without it the routes
   * that make one answer 503. The route never imports `@form/adapters` (the `adapters-only-from-composition-roots` rule):
   * `main.ts` builds this with `createOrgSecrets(keys)` from `@form/adapters/kms` and `app.ts` passes it through.
   */
  orgSecrets?: OrgSecrets | undefined;
  /** Core's producer queue: a replay sends `webhook.deliver` through it inside the transaction that inserts the delivery. */
  queue?: Queue | undefined;
  /** Keys the IP hash of audit records (`config.auth.secret`) and signs the delivery log's cursors. */
  secret: Uint8Array;
  now: () => Date;
  /** The egress check of a webhook URL (the composition root passes it once the webhooks are wired). */
  tenantEgress?: EgressGuard | undefined;
  /** Which URL schemes the deployment allows (`EGRESS_POLICY`); passed with `tenantEgress`. */
  edition?: EditionConfig | undefined;
}

const SECURITY = [{ session: [], org: [] }, { devUser: [], org: [] }];
const TAGS = ['webhooks'];

const formParams = z.object({ formId: z.uuid() });
const webhookParams = formParams.extend({ id: z.uuid() });
const deliveryParams = webhookParams.extend({ deliveryId: z.uuid() });

/**
 * What a member sends to make or replace a webhook: the `WebhookConfig` twin of `@form/schema` without what the server
 * decides. The id is the server's (never the client's), `secretRef` is the signing secret the server makes and seals, and
 * `filter` is not stored yet (migration 0023 has no column for it), so a body that names one is refused, not ignored.
 *
 * `purposeIds` may be empty here so that the route can answer `MISSING_PURPOSE` (422, with its own code) for `[]` as it does for a
 * purpose the form does not declare, and nothing is written for either. The rest default to the database's own defaults.
 */
const webhookBody = z.strictObject({
  url: WebhookConfigSchema.shape.url,
  enabled: z.boolean().default(true),
  events: WebhookConfigSchema.shape.events.min(1),
  keyBy: WebhookConfigSchema.shape.keyBy.default('key'),
  fieldKeys: z.union([z.array(FieldKeySchema).max(500), z.literal('all_in_purposes')]).default('all_in_purposes'),
  purposeIds: z.array(PurposeIdSchema).max(100),
  files: WebhookConfigSchema.shape.files.default('none'),
});
type WebhookBody = z.infer<typeof webhookBody>;

const isoOrNull = z.string().nullable();

/**
 * A webhook as the API sends it. The signing secret is never in it: `secretHint` is the last four characters of the one in
 * force (what the UI may show, migration 0023) and `secretRotatedAt` says when it was replaced.
 */
const webhookView = z.object({
  id: z.uuid(),
  formId: z.uuid(),
  url: z.string(),
  enabled: z.boolean(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  keyBy: z.enum(['key', 'id']),
  fieldKeys: z.union([z.array(z.string()), z.literal('all_in_purposes')]),
  purposeIds: z.array(z.string()),
  files: z.enum(['signed_urls', 'none']),
  secretHint: z.string(),
  secretRotatedAt: isoOrNull,
  consecutiveFailures: z.number().int().min(0),
  disabledReason: z.string().nullable(),
  /** The revision to send back in `If-Match` when saving. */
  rev: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type WebhookView = z.infer<typeof webhookView>;

/** The answer to the two calls that make a signing secret: the only time it is returned. */
const issuedSecret = z.object({
  /** `whsec_` and 32 random bytes in base64url. Shown once: the server keeps it sealed and cannot show it again. */
  secret: z.string(),
  secretHint: z.string(),
  secretRotatedAt: isoOrNull,
});

const deliveryView = z.object({
  id: z.uuid(),
  webhookId: z.uuid(),
  event: z.enum(WEBHOOK_EVENTS),
  submissionId: z.uuid().nullable(),
  status: z.enum(DELIVERY_STATUSES),
  attempt: z.number().int().min(0),
  httpStatus: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  /** At most 1 KB of the receiver's answer, scrubbed by the worker; null once it is older than 30 days. */
  responseSnippet: z.string().nullable(),
  /** The delivery this one sends again, when it is a replay. */
  replayOf: z.uuid().nullable(),
  nextAttemptAt: isoOrNull,
  createdAt: z.string(),
});
type DeliveryView = z.infer<typeof deliveryView>;

const deliveriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(DELIVERY_STATUSES).optional(),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
});

const etag = (rev: number): string => `"${rev}"`;

/** The revision a save read, from `If-Match` (`3`, `"3"` or `W/"3"`). */
function expectedRev(request: FastifyRequest): number {
  const header = request.headers['if-match'];
  const m = typeof header === 'string' ? /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(header) : null;
  if (!m) throw new ProblemError('WEBHOOK_REV_REQUIRED', 'Send the revision you read (the rev of GET .../webhooks/:id) in If-Match.');
  return Number(m[1]);
}

/** RLS limits the read to the caller's org, so a form of another org is as absent as one that never existed. */
async function requireForm(tx: Tx, formId: string): Promise<void> {
  const [form] = await tx.select({ id: forms.id }).from(forms).where(eq(forms.id, formId)).limit(1);
  if (!form) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
}

/**
 * The ids of the purposes the form's draft declares. Read leniently, like the review units: a draft that is half edited still
 * names the purposes it has, and anything that is not a purpose with a string id is ignored.
 */
async function declaredPurposeIds(tx: Tx, formId: string): Promise<Set<string>> {
  const [draft] = await tx.select({ purposes: sql<unknown>`${formDrafts.draft} #> '{privacy,purposes}'` }).from(formDrafts).where(eq(formDrafts.formId, formId)).limit(1);
  const list = Array.isArray(draft?.purposes) ? (draft.purposes as unknown[]) : [];
  return new Set(list.flatMap((p) => (typeof (p as { id?: unknown } | null)?.id === 'string' ? [(p as { id: string }).id] : [])));
}

/** Sending answers to an outside address is a disclosure: at least one purpose, each one the form's draft declares. */
function assertPurposes(purposeIds: readonly string[], declared: ReadonlySet<string>): void {
  if (purposeIds.length === 0) throw new ProblemError('MISSING_PURPOSE', 'Name the purpose this webhook serves: answers may only leave for a purpose the form declares.');
  const unknown = purposeIds.filter((id) => !declared.has(id));
  if (unknown.length > 0) throw new ProblemError('MISSING_PURPOSE', `The form does not declare the purpose ${unknown.map((id) => `"${id}"`).join(', ')}. Add it under the form's privacy purposes first.`);
}

/**
 * The save-time SSRF check of a webhook URL (WP-1.18): the edition decides the scheme, then the tenant egress guard decides
 * the address. Under `EGRESS_POLICY=open` (SaaS) only https; under `allowlist` http or https to a host the operator listed;
 * under `none` (air-gapped) nothing leaves, so every URL is refused. The guard then resolves the name and refuses private,
 * loopback, link-local (the cloud metadata address) and other special ranges. The worker checks again at every delivery
 * and connects to the address it checked, so a name that changes later does not get around this.
 *
 * The answer never says what the name resolved to: a member could otherwise map the internal DNS of the platform.
 */
async function assertUrlAllowed(url: string, deps: Pick<WebhookRouteDeps, 'tenantEgress' | 'edition'>): Promise<void> {
  const { tenantEgress, edition } = deps;
  if (!tenantEgress || !edition) throw new ProblemError('SERVICE_UNAVAILABLE', 'Webhook addresses cannot be checked on this server yet.');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProblemError('VALIDATION_FAILED', 'That is not a valid web address.');
  }
  if (edition.egressPolicy === 'none') throw new ProblemError('EGRESS_DENIED', 'This installation sends nothing outside its own network, so webhooks are not available.');
  if (edition.egressPolicy === 'open' && parsed.protocol !== 'https:') throw new ProblemError('EGRESS_DENIED', 'Use an https address: webhooks are not sent over plain http.');
  try {
    await tenantEgress.assertAllowed(parsed);
  } catch (err) {
    if (!isPortError(err, 'egress_denied')) throw err;
    throw new ProblemError(
      'EGRESS_DENIED',
      edition.egressPolicy === 'allowlist'
        ? "That address is not one this installation may send to. Ask its administrator to add the host to the egress allowlist."
        : 'That address is not a public internet address this server can reach. Private, loopback and link-local addresses, and names that do not resolve, are refused.',
    );
  }
}

/** The host (with its port) of a URL, for the audit record: never the path or the query, which may carry a token. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Each value once, in the order first given. */
const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/** The signing secret in the form the member copies: `whsec_` and the 32 key bytes in base64url. The bytes are what is sealed and what signs. */
function newSecret(): { key: Uint8Array; text: string; hint: string } {
  const key = randomBytes(32);
  const text = `whsec_${key.toString('base64url')}`;
  return { key: new Uint8Array(key), text, hint: text.slice(-4) };
}

const webhookColumns = {
  id: webhooks.id,
  formId: webhooks.formId,
  url: webhooks.url,
  enabled: webhooks.enabled,
  events: webhooks.events,
  keyBy: webhooks.keyBy,
  fieldKeys: webhooks.fieldKeys,
  purposeIds: webhooks.purposeIds,
  files: webhooks.files,
  secretId: webhooks.secretId,
  consecutiveFailures: webhooks.consecutiveFailures,
  disabledReason: webhooks.disabledReason,
  rev: webhooks.rev,
  createdAt: webhooks.createdAt,
  updatedAt: webhooks.updatedAt,
  // Never `secrets.enc`: the column is write-only for the API's database role, and a view has no use for it.
  secretMeta: secrets.meta,
  secretRotatedAt: secrets.rotatedAt,
};

interface StoredWebhook {
  id: string;
  formId: string;
  url: string;
  enabled: boolean;
  events: WebhookView['events'];
  keyBy: WebhookView['keyBy'];
  fieldKeys: WebhookView['fieldKeys'];
  purposeIds: string[];
  files: WebhookView['files'];
  secretId: string;
  consecutiveFailures: number;
  disabledReason: string | null;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
  secretMeta: Record<string, unknown>;
  secretRotatedAt: Date | null;
}

function viewOf(row: StoredWebhook): WebhookView {
  const { secretId: _secretId, secretMeta, secretRotatedAt, createdAt, updatedAt, ...rest } = row;
  return {
    ...rest,
    secretHint: typeof secretMeta.last4 === 'string' ? secretMeta.last4 : '',
    secretRotatedAt: secretRotatedAt?.toISOString() ?? null,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

/** One webhook of this form, with the facts of its secret that may be shown. A webhook of another form or org is absent. */
async function loadWebhook(tx: Tx, formId: string, id: string, o: { forUpdate?: boolean } = {}): Promise<StoredWebhook> {
  const query = tx
    .select(webhookColumns)
    .from(webhooks)
    .innerJoin(secrets, and(eq(secrets.orgId, webhooks.orgId), eq(secrets.id, webhooks.secretId)))
    .where(and(eq(webhooks.id, id), eq(webhooks.formId, formId)))
    .limit(1);
  const [row] = await (o.forUpdate ? query.for('update', { of: webhooks }) : query);
  if (!row) throw new ProblemError('NOT_FOUND', 'That webhook is not on this form.');
  return row as StoredWebhook;
}

const deliveryColumns = {
  id: webhookDeliveries.id,
  webhookId: webhookDeliveries.webhookId,
  event: webhookDeliveries.event,
  submissionId: webhookDeliveries.submissionId,
  status: webhookDeliveries.status,
  attempt: webhookDeliveries.attempt,
  httpStatus: webhookDeliveries.httpStatus,
  durationMs: webhookDeliveries.durationMs,
  responseSnippet: webhookDeliveries.responseSnippet,
  replayOf: webhookDeliveries.replayOf,
  nextAttemptAt: webhookDeliveries.nextAttemptAt,
  createdAt: webhookDeliveries.createdAt,
};

function deliveryOf(row: { createdAt: Date; nextAttemptAt: Date | null } & Omit<DeliveryView, 'createdAt' | 'nextAttemptAt'>): DeliveryView {
  return { ...row, nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() };
}

/** The top-level keys of the settings that differ, in a fixed order; lists compare as sets, so reordering them is no change. */
function changedKeys(before: WebhookView, next: Pick<WebhookView, 'url' | 'enabled' | 'events' | 'keyBy' | 'fieldKeys' | 'purposeIds' | 'files'>): string[] {
  const set = (v: readonly string[] | 'all_in_purposes') => (typeof v === 'string' ? v : JSON.stringify([...v].sort()));
  const keys: string[] = [];
  if (before.url !== next.url) keys.push('url');
  if (before.enabled !== next.enabled) keys.push('enabled');
  if (set(before.events) !== set(next.events)) keys.push('events');
  if (before.keyBy !== next.keyBy) keys.push('keyBy');
  if (set(before.fieldKeys) !== set(next.fieldKeys)) keys.push('fieldKeys');
  if (set(before.purposeIds) !== set(next.purposeIds)) keys.push('purposeIds');
  if (before.files !== next.files) keys.push('files');
  return keys;
}

/** The settings of a body as stored: lists with each value once. */
function settingsOf(body: WebhookBody) {
  return {
    url: body.url,
    enabled: body.enabled,
    events: unique(body.events),
    keyBy: body.keyBy,
    fieldKeys: typeof body.fieldKeys === 'string' ? body.fieldKeys : unique(body.fieldKeys),
    purposeIds: unique(body.purposeIds),
    files: body.files,
  };
}

/**
 * A form's webhooks and their delivery log: `/v1/forms/:formId/webhooks` (WP-1.18, INT-01). Sending answers to an outside
 * address is a disclosure (CONTRIBUTING §5, rule 6), so every route needs `data.route` (a member who has it is an owner, an
 * admin, an editor or a data collaborator; a creator is refused with a 403 that the error handler audits as
 * `request.authorize`, and RLS repeats the check: `webhooks_data_route`, `secrets_access`, `webhook_deliveries_*`). Every read
 * and write runs in `withTenant`, so the org is the caller's membership and a form, webhook or delivery of another org answers 404.
 *
 * - A webhook names `purposeIds`, at least one and each declared in the draft's `privacy.purposes` (422 `MISSING_PURPOSE`,
 *   nothing written).
 * - The URL passes the save-time SSRF check (`assertUrlAllowed`; 422 `EGRESS_DENIED`) on every save.
 * - The server makes the signing secret: 32 random bytes, sealed under the org's key into `secrets` (kind `webhook_hmac`),
 *   returned as `whsec_<base64url>` once, by the create and the rotate call, and never again. No route reads `secrets.enc`.
 * - A save names the revision it read in `If-Match` (428 without, 409 when stale).
 * - A replay inserts a new delivery for the same event and response and sends `webhook.deliver` in the same transaction.
 *
 * The routes check what they need from the database before what they need from the deployment (the secret sealer, the egress
 * guard, the queue), so another org's ids are a 404 whether or not the deployment has them.
 */
export function webhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** The audit fields every record of a signed-in caller carries besides the actor: session, address hash, user agent. */
  const client = (request: FastifyRequest) => {
    const info = clientInfo(request, deps.secret, deps.now());
    return { sessionId: accountOf(request).session?.id ?? null, actorIpHash: hex(info.ipHash), actorUa: info.ua };
  };

  /** Seals a new key under the org's key context, as the secret row `secretId` (never called inside a transaction: it asks the KMS). */
  const seal = async (orgId: string, secretId: string, key: Uint8Array) => {
    if (!deps.orgSecrets) throw new ProblemError('SERVICE_UNAVAILABLE', 'Webhook signing secrets cannot be stored on this server yet.');
    const sealed = await deps.orgSecrets.seal({ orgId, secretId, kind: 'webhook_hmac' }, key);
    // A spread, so the stored value is a plain object of the sealed envelope's own fields.
    return { ...sealed };
  };

  r.get(
    '/v1/forms/:formId/webhooks',
    {
      config: { auth: 'user', perm: 'data.route' },
      schema: {
        tags: TAGS,
        summary: "A form's webhooks",
        description: 'Oldest first. Never carries a signing secret: `secretHint` is its last four characters. Needs `data.route`.',
        security: SECURITY,
        params: formParams,
        response: { 200: z.object({ items: z.array(webhookView) }) },
      },
    },
    async (request, reply) => {
      const { formId } = request.params;
      const rows = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, async (tx) => {
        await requireForm(tx, formId);
        return tx
          .select(webhookColumns)
          .from(webhooks)
          .innerJoin(secrets, and(eq(secrets.orgId, webhooks.orgId), eq(secrets.id, webhooks.secretId)))
          .where(eq(webhooks.formId, formId))
          .orderBy(asc(webhooks.createdAt), asc(webhooks.id));
      });
      reply.header('cache-control', 'no-store');
      return { items: rows.map((row) => viewOf(row as StoredWebhook)) };
    },
  );

  r.post(
    '/v1/forms/:formId/webhooks',
    {
      config: { auth: 'user', perm: 'data.route' },
      schema: {
        tags: TAGS,
        summary: 'Create a webhook',
        description:
          'Needs `data.route`. `purposeIds` must name at least one purpose the form’s draft declares (422 `MISSING_PURPOSE`); the URL must pass the egress check of the deployment (422 `EGRESS_DENIED`: https only on SaaS, an allowlisted host on-prem, nothing air-gapped, never a private or link-local address). The server makes the signing secret and returns it as `secret` in this answer only: store it now, it cannot be shown again (`POST .../rotate-secret` issues a new one). Audited as `webhook.saved`.',
        security: SECURITY,
        params: formParams,
        body: webhookBody,
        response: { 201: webhookView.extend({ secret: z.string() }) },
      },
    },
    async (request, reply) => {
      const { formId } = request.params;
      const tenant = tenantOf(request);
      const who = client(request);
      const settings = settingsOf(request.body);

      // Read first, under row-level security: another org's form is a 404 before anything about the deployment is asked.
      const declared = await withTenant(deps.db, { ...tenant, readOnly: true }, async (tx) => {
        await requireForm(tx, formId);
        return declaredPurposeIds(tx, formId);
      });
      assertPurposes(settings.purposeIds, declared);
      await assertUrlAllowed(settings.url, deps);

      const id = uuidv7(deps.now().getTime());
      const secretId = uuidv7(deps.now().getTime());
      const issued = newSecret();
      const enc = await seal(tenant.orgId, secretId, issued.key);
      const host = hostOf(settings.url);
      const events = settings.events;
      const purposeIds = settings.purposeIds;

      const row = await withTenant(deps.db, tenant, async (tx) => {
        await requireForm(tx, formId);
        // The org comes from the caller's membership, never from the request, and the ids are the server's.
        await tx.insert(secrets).values({ id: secretId, orgId: tenant.orgId, kind: 'webhook_hmac', enc, meta: { last4: issued.hint } });
        await tx.insert(webhooks).values({
          id,
          orgId: tenant.orgId,
          formId,
          secretId,
          ...settings,
          updatedAt: deps.now(),
          updatedBy: accountOf(request).userId,
        });
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'webhook.saved',
          resourceType: 'webhook',
          resourceId: id,
          formId,
          outcome: 'success',
          metadata: { change: 'created', host, events, purposeIds, rev: 1 },
        });
        return loadWebhook(tx, formId, id);
      });
      reply.header('cache-control', 'no-store');
      reply.header('etag', etag(row.rev));
      return reply.code(201).send({ ...viewOf(row), secret: issued.text });
    },
  );

  r.get(
    '/v1/forms/:formId/webhooks/:id',
    {
      config: { auth: 'user', perm: 'data.route' },
      schema: {
        tags: TAGS,
        summary: 'Read a webhook',
        description: 'Needs `data.route`. The `ETag` is the revision to send back in `If-Match`. Never carries the signing secret.',
        security: SECURITY,
        params: webhookParams,
        response: { 200: webhookView },
      },
    },
    async (request, reply) => {
      const { formId, id } = request.params;
      const row = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, async (tx) => {
        await requireForm(tx, formId);
        return loadWebhook(tx, formId, id);
      });
      reply.header('cache-control', 'no-store');
      reply.header('etag', etag(row.rev));
      return viewOf(row);
    },
  );

  r.put(
    '/v1/forms/:formId/webhooks/:id',
    {
      config: { auth: 'user', perm: 'data.route' },
      schema: {
        tags: TAGS,
        summary: 'Save a webhook',
        description:
          'Replaces the settings (a key left out takes its default) if `If-Match` names the revision that was read, else 409 `WEBHOOK_REV_CONFLICT`; without it, 428. The same checks as creating: declared purposes (422 `MISSING_PURPOSE`) and the egress check of the URL (422 `EGRESS_DENIED`), every time. Switching a webhook that was off back on, or changing its URL, clears the failure count and the reason it was switched off. The signing secret is not touched (see `rotate-secret`). Audited as `webhook.saved` with the keys that changed.',
        security: SECURITY,
        params: webhookParams,
        body: webhookBody,
        response: { 200: webhookView },
      },
    },
    async (request, reply) => {
      const { formId, id } = request.params;
      const tenant = tenantOf(request);
      const who = client(request);
      const expected = expectedRev(request);
      const next = settingsOf(request.body);
      const stale = () => new ProblemError('WEBHOOK_REV_CONFLICT', 'The webhook changed since you read it. Reload it and apply your change again.');

      const declared = await withTenant(deps.db, { ...tenant, readOnly: true }, async (tx) => {
        await requireForm(tx, formId);
        const current = await loadWebhook(tx, formId, id);
        if (current.rev !== expected) throw stale();
        return declaredPurposeIds(tx, formId);
      });
      assertPurposes(next.purposeIds, declared);
      await assertUrlAllowed(next.url, deps);
      const host = hostOf(next.url);

      const saved = await withTenant(deps.db, tenant, async (tx) => {
        await requireForm(tx, formId);
        // Locked, so two saves of one webhook take turns and the second sees the first's revision.
        const current = await loadWebhook(tx, formId, id, { forUpdate: true });
        if (current.rev !== expected) throw stale();
        const before = viewOf(current);
        // A webhook that was switched off (by the worker after repeated failures, or by a member) starts afresh when it is
        // switched on, and one that is sent somewhere else has no use for the failures of the old address.
        const fresh = (!current.enabled && next.enabled) || current.url !== next.url;
        const [updated] = await tx
          .update(webhooks)
          .set({
            ...next,
            rev: sql`${webhooks.rev} + 1`,
            updatedAt: deps.now(),
            updatedBy: accountOf(request).userId,
            ...(fresh ? { consecutiveFailures: 0, disabledReason: null } : {}),
          })
          .where(and(eq(webhooks.id, id), eq(webhooks.formId, formId), eq(webhooks.rev, expected)))
          .returning({ rev: webhooks.rev });
        if (!updated) throw stale();
        const changed = changedKeys(before, next);
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'webhook.saved',
          resourceType: 'webhook',
          resourceId: id,
          formId,
          outcome: 'success',
          metadata: { change: 'updated', host, changedKeys: changed, rev: updated.rev },
        });
        return loadWebhook(tx, formId, id);
      });
      reply.header('cache-control', 'no-store');
      reply.header('etag', etag(saved.rev));
      return viewOf(saved);
    },
  );

  r.delete(
    '/v1/forms/:formId/webhooks/:id',
    {
      config: { auth: 'user', perm: 'data.route' },
      schema: {
        tags: TAGS,
        summary: 'Delete a webhook',
        description:
          'Deletes the webhook, its signing secret and its delivery log; a delivery still queued for it finds nothing and ends. Needs `data.route`. Audited as `webhook.deleted` with the host the URL had.',
        security: SECURITY,
        params: webhookParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const { formId, id } = request.params;
      const tenant = tenantOf(request);
      const who = client(request);
      await withTenant(deps.db, tenant, async (tx) => {
        await requireForm(tx, formId);
        const current = await loadWebhook(tx, formId, id, { forUpdate: true });
        const host = hostOf(current.url);
        // The deliveries go with the webhook (`on delete cascade`); the secret is the webhook's own, so it goes after it.
        await tx.delete(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.formId, formId)));
        await tx.delete(secrets).where(and(eq(secrets.id, current.secretId), eq(secrets.kind, 'webhook_hmac')));
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'webhook.deleted',
          resourceType: 'webhook',
          resourceId: id,
          formId,
          outcome: 'success',
          metadata: { host },
        });
      });
      return reply.code(204).send(null);
    },
  );

  r.post(
    '/v1/forms/:formId/webhooks/:id/rotate-secret',
    {
      config: { auth: 'user', perm: 'data.route' },
      schema: {
        tags: TAGS,
        summary: "Replace a webhook's signing secret",
        description:
          'Makes a new secret, seals it in place of the old one and returns it as `secret` in this answer only. The old secret stops verifying at once, including for deliveries already queued, which are signed when they are sent. Needs `data.route`. Audited as `webhook.secret_rotated`.',
        security: SECURITY,
        params: webhookParams,
        response: { 200: issuedSecret },
      },
    },
    async (request, reply) => {
      const { formId, id } = request.params;
      const tenant = tenantOf(request);
      const who = client(request);
      const current = await withTenant(deps.db, { ...tenant, readOnly: true }, async (tx) => {
        await requireForm(tx, formId);
        return loadWebhook(tx, formId, id);
      });
      const issued = newSecret();
      // The secret keeps its row, so the context it is sealed for (org, row, kind) is the one the worker opens it with.
      const enc = await seal(tenant.orgId, current.secretId, issued.key);
      const rotatedAt = deps.now();
      await withTenant(deps.db, tenant, async (tx) => {
        await requireForm(tx, formId);
        const [row] = await tx
          .update(secrets)
          .set({ enc, meta: { last4: issued.hint }, rotatedAt })
          .where(and(eq(secrets.id, current.secretId), eq(secrets.kind, 'webhook_hmac')))
          .returning({ id: secrets.id });
        // The webhook was deleted between the two transactions.
        if (!row) throw new ProblemError('NOT_FOUND', 'That webhook is not on this form.');
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'webhook.secret_rotated',
          resourceType: 'webhook',
          resourceId: id,
          formId,
          outcome: 'success',
          metadata: { rotatedAt: rotatedAt.toISOString() },
        });
      });
      reply.header('cache-control', 'no-store');
      return { secret: issued.text, secretHint: issued.hint, secretRotatedAt: rotatedAt.toISOString() };
    },
  );

  r.get(
    '/v1/forms/:formId/webhooks/:id/deliveries',
    {
      config: { auth: 'user', perm: 'data.route' },
      schema: {
        tags: TAGS,
        summary: "A webhook's delivery log",
        description:
          'Newest first, pages by cursor: `nextCursor` is signed and bound to this webhook and filter; pass it back unchanged and stop when it is null. Each row is one delivery of one event: its status, the receiver’s HTTP status, the duration, the attempt and a scrubbed snippet of the answer (30 days). Needs `data.route`.',
        security: SECURITY,
        params: webhookParams,
        querystring: deliveriesQuery,
        response: { 200: z.object({ items: z.array(deliveryView), nextCursor: z.string().nullable() }) },
      },
    },
    async (request, reply) => {
      const { formId, id } = request.params;
      const { limit, status, cursor } = request.query;
      const tenant = tenantOf(request);
      // The signature covers everything that changes which rows come in which order, so a cursor cannot be carried to
      // another webhook, filter, caller or org.
      const scope = JSON.stringify(['webhook-deliveries', tenant.orgId, id, status ?? null]);
      let after: [string, string] | undefined;
      if (cursor !== undefined) {
        const values = readCursor(deps.secret, scope, cursor);
        const [at, last] = values ?? [];
        if (values?.length !== 2 || typeof at !== 'string' || !isUuid(last)) throw new ProblemError('INVALID_CURSOR');
        after = [at, last];
      }
      const rows = await withTenant(deps.db, { ...tenant, readOnly: true }, async (tx) => {
        await requireForm(tx, formId);
        await loadWebhook(tx, formId, id);
        return tx
          .select({ ...deliveryColumns, position: sql<string>`(${webhookDeliveries.createdAt})::text` })
          .from(webhookDeliveries)
          .where(
            and(
              eq(webhookDeliveries.webhookId, id),
              status ? eq(webhookDeliveries.status, status) : undefined,
              // The row after the cursor in the list's own order. A row comparison reads (time, id) as one position.
              after ? sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : undefined,
            ),
          )
          .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
          // One row more than the page, to know whether there is a next page without a count.
          .limit(limit + 1);
      });
      const page = rows.slice(0, limit);
      const lastRow = page.at(-1);
      reply.header('cache-control', 'no-store');
      return {
        items: page.map(deliveryOf),
        nextCursor: rows.length > limit && lastRow ? signCursor(deps.secret, scope, [lastRow.position, lastRow.id]) : null,
      };
    },
  );

  r.post(
    '/v1/forms/:formId/webhooks/:id/deliveries/:deliveryId/replay',
    {
      config: { auth: 'user', perm: 'data.route' },
      schema: {
        tags: TAGS,
        summary: 'Send a delivery again',
        description:
          'Inserts a new delivery for the same event and response (`replayOf` names the original; a replay of a replay names the first) and sends `webhook.deliver` for it in the same transaction, so the row and the job exist together or not at all. The worker signs it afresh and applies the webhook’s purposes to the answers as they are now. A webhook that is switched off is 409 `WEBHOOK_DISABLED`. Needs `data.route`. Audited as `webhook.replayed`.',
        security: SECURITY,
        params: deliveryParams,
        response: { 201: deliveryView },
      },
    },
    async (request, reply) => {
      const { formId, id, deliveryId } = request.params;
      const tenant = tenantOf(request);
      const who = client(request);
      const newId = uuidv7(deps.now().getTime());
      const created = await withTenant(deps.db, tenant, async (tx) => {
        await requireForm(tx, formId);
        const webhook = await loadWebhook(tx, formId, id);
        const [original] = await tx
          .select({
            id: webhookDeliveries.id,
            event: webhookDeliveries.event,
            submissionId: webhookDeliveries.submissionId,
            submissionReceivedAt: webhookDeliveries.submissionReceivedAt,
            replayOf: webhookDeliveries.replayOf,
          })
          .from(webhookDeliveries)
          .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, id)))
          .limit(1);
        if (!original) throw new ProblemError('NOT_FOUND', 'That delivery is not in this webhook’s log.');
        if (!webhook.enabled) throw new ProblemError('WEBHOOK_DISABLED', 'Switch the webhook on before sending a delivery again.');
        // A row without its job would stay pending for ever, so without a queue nothing is written.
        const queue = deps.queue;
        if (!queue) throw new ProblemError('SERVICE_UNAVAILABLE', 'Deliveries cannot be queued on this server yet.');
        const replayOf = original.replayOf ?? original.id;
        // The org comes from the caller's membership; the event and the response are the original's, never the client's.
        const [row] = await tx
          .insert(webhookDeliveries)
          .values({
            id: newId,
            orgId: tenant.orgId,
            webhookId: id,
            event: original.event,
            submissionId: original.submissionId,
            submissionReceivedAt: original.submissionReceivedAt,
            replayOf,
          })
          .returning(deliveryColumns);
        const jobId = await queue.send(
          'webhook.deliver',
          { orgId: tenant.orgId, resource: { type: 'webhook_delivery', id: newId }, data: { deliveryId: newId } },
          { tx: txExecutor(tx) },
        );
        // A standard queue gives every send an id; none means the job was not stored, and a delivery without its job would
        // never be sent: fail the whole transaction instead.
        if (jobId === null) throw new Error('webhook.deliver was not enqueued');
        const event = original.event;
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'webhook.replayed',
          resourceType: 'webhook',
          resourceId: id,
          formId,
          outcome: 'success',
          metadata: { deliveryId: newId, replayOf, event },
        });
        return row!;
      });
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(deliveryOf(created));
    },
  );
}
