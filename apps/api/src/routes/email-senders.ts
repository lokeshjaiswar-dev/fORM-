import { and, asc, eq, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, auditActor, emailSenders, notifications, secrets, users, withTenant, type Db, type Tx } from '@form/db';
import type { Mailer, OrgSecrets } from '@form/ports';
import { accountOf, clientInfo, tenantOf } from '../auth.ts';
import { ProblemError } from '../errors.ts';
import { hex } from '../modules/auth/crypto.ts';
import { uuidv7 } from '../uuid7.ts';

export interface EmailSenderRouteDeps {
  /** The request pool: every read and write goes through `withTenant` on it, so row-level security limits it to the caller's org. */
  db: Db;
  /** The small separate pool for denied and failed audit records (ADR-0006). */
  auditDb: Db;
  /**
   * Seals an SMTP URL under the org's key context (`orgSecrets.seal`, kind `smtp`); without it the routes that store one
   * answer 503. The route never imports `@form/adapters` (the `adapters-only-from-composition-roots` rule): `main.ts` builds
   * this with `createOrgSecrets(keys)` from `@form/adapters/kms` and `app.ts` passes it through.
   */
  orgSecrets?: OrgSecrets | undefined;
  /** Keys the IP hash of audit records (`config.auth.secret`). */
  secret: Uint8Array;
  now: () => Date;
  /** The mailer of one org's sender, for the test message (the composition root passes it once the notifications are wired). */
  orgMailer?: ((orgId: string) => Mailer) | undefined;
}

const SECURITY = [{ session: [], org: [] }, { devUser: [], org: [] }];
const TAGS = ['email-senders'];
const isoInstant = z.iso.datetime({ offset: true });
const idParam = z.object({ id: z.uuid() });

/** No control character (CR and LF would end a header line), no angle brackets (a display name that closes its own address). */
// eslint-disable-next-line no-control-regex
const PLAIN_NAME = /^[^\u0000-\u001f\u007f<>]*$/;

/** What the SMTP URL says about itself that the UI may show. The password is never in it. */
export interface SmtpMeta {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
}

/**
 * The parts of an SMTP URL the UI may show (host, port, TLS mode, user name), or null when the text is not an
 * `smtp://` or `smtps://` URL with a host. Used both to refuse a bad URL and to make the `meta` of the secret row, so the
 * password never has to be read back to show what a sender points at.
 */
export function parseSmtpUrl(raw: string): SmtpMeta | null {
  // eslint-disable-next-line no-control-regex
  if (raw.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '') return null;
  const secure = url.protocol === 'smtps:';
  let username: string | null = null;
  if (url.username !== '') {
    try {
      username = decodeURIComponent(url.username);
    } catch {
      return null;
    }
  }
  return { host, port: url.port === '' ? (secure ? 465 : 25) : Number(url.port), secure, username };
}

/**
 * A mail server's error text made safe to store and show: URLs, anything with an `@` in it (an address, `user:pass@host`)
 * and control characters are replaced, and the text is cut. The SMTP URL carries the credentials, so no part of one may
 * reach `last_test_error`, which every member who may read senders can see.
 */
export function scrubMailError(message: string): string {
  const cleaned = message
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']*/gi, '[url]')
    .replace(/[^\s<>"',;()]*@[^\s<>"',;()]*/g, '[address]')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 300 ? `${cleaned.slice(0, 297)}...` : cleaned;
}

const smtpUrlField = z
  .string()
  .max(2048)
  .refine((v) => parseSmtpUrl(v) !== null, 'must be an smtp:// or smtps:// URL with a host (for example smtps://user:password@smtp.example.com:465)');
const nameField = z.string().trim().min(1).max(120).regex(PLAIN_NAME, 'must not contain control characters or angle brackets');
const fromAddressField = z.email().max(254);
const fromNameField = z.string().trim().max(120).regex(PLAIN_NAME, 'must not contain control characters or angle brackets');

const createBody = z.strictObject({ name: nameField, fromAddress: fromAddressField, fromName: fromNameField.nullish(), smtpUrl: smtpUrlField });
const patchBody = z
  .strictObject({ name: nameField, fromAddress: fromAddressField, fromName: fromNameField.nullable(), smtpUrl: smtpUrlField })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'send at least one field to change');

const smtpView = z.object({ host: z.string(), port: z.number().int(), secure: z.boolean(), username: z.string().nullable() });
const senderView = z.object({
  id: z.uuid(),
  name: z.string(),
  fromAddress: z.string(),
  fromName: z.string().nullable(),
  verifiedAt: isoInstant.nullable(),
  /** What the sender points at (host, port, user name; never the password). Null for a caller without `org.settings`. */
  smtp: smtpView.nullable(),
  /** What the last failed test said, scrubbed. Null for a caller without `org.settings`. */
  lastTestError: z.string().nullable(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
type SenderView = z.infer<typeof senderView>;
const testView = z.object({ ok: z.boolean(), verifiedAt: isoInstant.nullable(), error: z.string().nullable() });

/** Every column of a sender the API may read, with the secret's public `meta` (null for a caller RLS keeps away from the secret). */
const senderColumns = {
  id: emailSenders.id,
  name: emailSenders.name,
  fromAddress: emailSenders.fromAddress,
  fromName: emailSenders.fromName,
  smtpSecretId: emailSenders.smtpSecretId,
  verifiedAt: emailSenders.verifiedAt,
  lastTestError: emailSenders.lastTestError,
  createdAt: emailSenders.createdAt,
  updatedAt: emailSenders.updatedAt,
  meta: secrets.meta,
};

type SenderRow = {
  id: string;
  name: string;
  fromAddress: string;
  fromName: string | null;
  smtpSecretId: string;
  verifiedAt: Date | null;
  lastTestError: string | null;
  createdAt: Date;
  updatedAt: Date;
  meta: Record<string, unknown> | null;
};

function smtpOf(meta: Record<string, unknown> | null): SmtpMeta | null {
  if (!meta) return null;
  const { host, port, secure, username } = meta;
  if (typeof host !== 'string' || typeof port !== 'number' || typeof secure !== 'boolean') return null;
  return { host, port, secure, username: typeof username === 'string' ? username : null };
}

/** The sender as the API sends it. Without `org.settings` the credentials' public part and the test error stay out. */
function viewOf(row: SenderRow, mayManage: boolean): SenderView {
  return {
    id: row.id,
    name: row.name,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    smtp: mayManage ? smtpOf(row.meta) : null,
    lastTestError: mayManage ? row.lastTestError : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The org's senders with the public meta of their secret; RLS limits both tables to the caller's org (and `secrets` to `org.settings`). */
function selectSenders(tx: Tx, where?: SQL) {
  return tx
    .select(senderColumns)
    .from(emailSenders)
    .leftJoin(secrets, and(eq(secrets.orgId, emailSenders.orgId), eq(secrets.id, emailSenders.smtpSecretId), eq(secrets.kind, 'smtp')))
    .where(where);
}

async function requireSender(tx: Tx, id: string, o: { forUpdate?: boolean } = {}): Promise<SenderRow> {
  // `for update of email_senders`: the join to the secret is only for the meta, so only the sender row is locked.
  const query = selectSenders(tx, eq(emailSenders.id, id)).limit(1);
  const [row] = await (o.forUpdate ? query.for('update', { of: emailSenders }) : query);
  if (!row) throw new ProblemError('NOT_FOUND', 'That email sender is not in this organisation.');
  return row;
}

/** Postgres `foreign_key_violation`, whether the driver error is bare or wrapped by drizzle. */
function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return e?.code === '23503' || e?.cause?.code === '23503';
}

/**
 * The org's email senders: `/v1/email-senders` (WP-1.16, NOT-01). A sender is a "from" mailbox with its own SMTP relay.
 * The SMTP URL carries the credentials, so it is write-only: it is sealed under the org's key as a `secrets` row of kind
 * `smtp` (`orgSecrets.seal`, bound to the org, the secret id and the kind), the sender points at that row, and no route
 * returns the URL or anything sealed. What a caller with `org.settings` may see of it is the `meta` made when it was
 * stored: host, port, TLS mode and user name.
 *
 * Writing needs `org.settings` (and so does the secret row's own RLS policy). Reading the list needs only `forms.read`,
 * because whoever edits a form's emails has to pick a sender; those callers get the name and the From address, not the
 * credentials' meta nor the test error. Every query runs in `withTenant`, so another org's sender is a 404. Each write has
 * a case in `test/isolation-cases/notifications.ts`.
 */
export function emailSenderRoutes(app: FastifyInstance, deps: EmailSenderRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** The audit fields every record of a signed-in caller carries besides the actor: session, address hash, user agent. */
  const client = (request: FastifyRequest) => {
    const info = clientInfo(request, deps.secret, deps.now());
    return { sessionId: accountOf(request).session?.id ?? null, actorIpHash: hex(info.ipHash), actorUa: info.ua };
  };
  const mayManage = (request: FastifyRequest) => tenantOf(request).perms?.includes('org.settings') === true;

  r.get(
    '/v1/email-senders',
    {
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags: TAGS,
        summary: "List the org's email senders",
        description:
          'Oldest first. A caller with `org.settings` also gets `smtp` (host, port, TLS mode and user name of the relay) and `lastTestError`; anyone else gets them as null. The SMTP URL and its password are never returned, to anyone.',
        security: SECURITY,
        response: { 200: z.object({ items: z.array(senderView) }) },
      },
    },
    async (request, reply) => {
      const manage = mayManage(request);
      const rows = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, (tx) => selectSenders(tx).orderBy(asc(emailSenders.createdAt), asc(emailSenders.id)));
      reply.header('cache-control', 'private, no-store');
      return { items: rows.map((row) => viewOf(row, manage)) };
    },
  );

  r.post(
    '/v1/email-senders',
    {
      config: { auth: 'user', perm: 'org.settings' },
      schema: {
        tags: TAGS,
        summary: 'Add an email sender',
        description:
          'Seals the SMTP URL under the org\'s key and never returns it. A new sender is unverified until `POST /v1/email-senders/:id/test` has delivered a message. Without the key service configured the answer is 503. Audited as `email_sender.saved` with the keys that were set, never the address or the URL.',
        security: SECURITY,
        body: createBody,
        response: { 201: senderView },
      },
    },
    async (request, reply) => {
      if (!deps.orgSecrets) throw new ProblemError('SERVICE_UNAVAILABLE', 'Email senders need the key service, which is not configured.');
      const tenant = tenantOf(request);
      const body = request.body;
      const meta = parseSmtpUrl(body.smtpUrl);
      if (!meta) throw new ProblemError('BAD_REQUEST', 'The SMTP URL is not valid.');
      const who = client(request);
      const secretId = uuidv7();
      const senderId = uuidv7();
      // The key service is called before the transaction, so a slow call does not hold a connection.
      const enc = await deps.orgSecrets.seal({ orgId: tenant.orgId, secretId, kind: 'smtp' }, body.smtpUrl);
      // The keys that were set, never what they were set to.
      const changedKeys = ['name', 'fromAddress', ...(body.fromName ? ['fromName'] : []), 'smtpUrl'];
      const created = await withTenant(deps.db, tenant, async (tx) => {
        await tx.insert(secrets).values({ id: secretId, orgId: tenant.orgId, kind: 'smtp', enc: enc as unknown as Record<string, unknown>, meta: { ...meta } });
        await tx.insert(emailSenders).values({
          id: senderId,
          orgId: tenant.orgId,
          name: body.name,
          fromAddress: body.fromAddress,
          fromName: body.fromName ? body.fromName : null,
          smtpSecretId: secretId,
        });
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'email_sender.saved',
          resourceType: 'email_sender',
          resourceId: senderId,
          outcome: 'success',
          metadata: { change: 'created', changedKeys },
        });
        return requireSender(tx, senderId);
      });
      return reply.code(201).send(viewOf(created, true));
    },
  );

  r.patch(
    '/v1/email-senders/:id',
    {
      config: { auth: 'user', perm: 'org.settings' },
      schema: {
        tags: TAGS,
        summary: 'Change an email sender',
        description:
          'Any of `name`, `fromAddress`, `fromName` (null clears it) and `smtpUrl`. A new `smtpUrl` is sealed as a new secret, the sender is pointed at it and the old secret is deleted. Changing the address or the URL clears `verifiedAt` and the test error: the new settings have not delivered anything yet.',
        security: SECURITY,
        params: idParam,
        body: patchBody,
        response: { 200: senderView },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      const { id } = request.params;
      const body = request.body;
      const who = client(request);
      let sealed: { secretId: string; enc: Record<string, unknown>; meta: SmtpMeta } | undefined;
      if (body.smtpUrl !== undefined) {
        if (!deps.orgSecrets) throw new ProblemError('SERVICE_UNAVAILABLE', 'Email senders need the key service, which is not configured.');
        const meta = parseSmtpUrl(body.smtpUrl);
        if (!meta) throw new ProblemError('BAD_REQUEST', 'The SMTP URL is not valid.');
        const secretId = uuidv7();
        sealed = { secretId, enc: (await deps.orgSecrets.seal({ orgId: tenant.orgId, secretId, kind: 'smtp' }, body.smtpUrl)) as unknown as Record<string, unknown>, meta };
      }
      const updated = await withTenant(deps.db, tenant, async (tx) => {
        const before = await requireSender(tx, id, { forUpdate: true });
        const changedKeys: string[] = [];
        const set: Partial<Pick<typeof emailSenders.$inferInsert, 'name' | 'fromAddress' | 'fromName' | 'smtpSecretId' | 'verifiedAt' | 'lastTestError'>> = {};
        if (body.name !== undefined && body.name !== before.name) {
          set.name = body.name;
          changedKeys.push('name');
        }
        if (body.fromAddress !== undefined && body.fromAddress !== before.fromAddress) {
          set.fromAddress = body.fromAddress;
          changedKeys.push('fromAddress');
        }
        // An empty display name is no display name.
        const fromName = body.fromName === undefined ? undefined : body.fromName === '' ? null : body.fromName;
        if (fromName !== undefined && fromName !== before.fromName) {
          set.fromName = fromName;
          changedKeys.push('fromName');
        }
        if (sealed) {
          await tx.insert(secrets).values({ id: sealed.secretId, orgId: tenant.orgId, kind: 'smtp', enc: sealed.enc, meta: { ...sealed.meta } });
          set.smtpSecretId = sealed.secretId;
          changedKeys.push('smtpUrl');
        }
        if (changedKeys.length === 0) return before;
        // The relay or the From address changed: nothing has been delivered through the new combination yet.
        if (changedKeys.includes('smtpUrl') || changedKeys.includes('fromAddress')) {
          set.verifiedAt = null;
          set.lastTestError = null;
        }
        await tx.update(emailSenders).set({ ...set, updatedAt: deps.now() }).where(eq(emailSenders.id, id));
        // The old credentials go with the pointer: nothing may keep a sealed copy of a password the org replaced.
        if (sealed) await tx.delete(secrets).where(and(eq(secrets.id, before.smtpSecretId), eq(secrets.kind, 'smtp')));
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'email_sender.saved',
          resourceType: 'email_sender',
          resourceId: id,
          outcome: 'success',
          metadata: { change: 'updated', changedKeys },
        });
        return requireSender(tx, id);
      });
      return viewOf(updated, true);
    },
  );

  r.delete(
    '/v1/email-senders/:id',
    {
      config: { auth: 'user', perm: 'org.settings' },
      schema: {
        tags: TAGS,
        summary: 'Delete an email sender and its sealed credentials',
        description:
          'A sender that a notification still sends from is 409 `EMAIL_SENDER_IN_USE`: change those notifications first, so none of them silently changes its From address.',
        security: SECURITY,
        params: idParam,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      const { id } = request.params;
      const who = client(request);
      const inUse = () => new ProblemError('EMAIL_SENDER_IN_USE', 'A notification still sends from this sender. Choose another sender for it first.');
      try {
        await withTenant(deps.db, tenant, async (tx) => {
          const sender = await requireSender(tx, id, { forUpdate: true });
          const [used] = await tx.select({ id: notifications.id }).from(notifications).where(eq(notifications.senderId, id)).limit(1);
          if (used) throw inUse();
          await tx.delete(emailSenders).where(eq(emailSenders.id, id));
          await tx.delete(secrets).where(and(eq(secrets.id, sender.smtpSecretId), eq(secrets.kind, 'smtp')));
          await audit.append(tx, tenant.orgId, {
            ...auditActor(tenant),
            sessionId: who.sessionId,
            actorIpHash: who.actorIpHash,
            actorUa: who.actorUa,
            action: 'email_sender.deleted',
            resourceType: 'email_sender',
            resourceId: id,
            outcome: 'success',
          });
        });
      } catch (err) {
        // A notification that named the sender after the check above: the foreign key is the last word.
        if (isForeignKeyViolation(err)) throw inUse();
        throw err;
      }
      return reply.code(204).send(null);
    },
  );

  r.post(
    '/v1/email-senders/:id/test',
    {
      config: { auth: 'user', perm: 'org.settings' },
      schema: {
        tags: TAGS,
        summary: 'Send a test message through a sender, to the caller\'s own address',
        description:
          'Checks the connection and sends one message to the signed-in caller\'s own address (never to an address in the request). A delivered message sets `verifiedAt`; a failure clears it and stores the server\'s error on the sender, scrubbed of URLs and addresses. A failed test is a 200 with `ok: false`, not an error: the answer is the result. Without the org mailer the answer is 503.',
        security: SECURITY,
        params: idParam,
        response: { 200: testView },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      const { id } = request.params;
      const who = client(request);
      // One short transaction to read, none while the mail server answers (it may take seconds), one to record.
      const { sender, to } = await withTenant(deps.db, { ...tenant, readOnly: true }, async (tx) => {
        const found = await requireSender(tx, id);
        const [me] = await tx.select({ email: users.email }).from(users).where(eq(users.id, accountOf(request).userId)).limit(1);
        if (!me) throw new ProblemError('NOT_FOUND', 'No such user.');
        return { sender: found, to: me.email };
      });
      if (!deps.orgMailer) throw new ProblemError('SERVICE_UNAVAILABLE', 'Test messages need the org mailer, which is not configured.');

      let error: string | null = null;
      try {
        const mailer = deps.orgMailer(tenant.orgId);
        const verified = await mailer.verify(sender.smtpSecretId);
        if (!verified.ok) {
          error = scrubMailError(verified.error ?? '') || 'The mail server did not accept the connection.';
        } else {
          await mailer.send({
            from: { address: sender.fromAddress, ...(sender.fromName ? { name: sender.fromName } : {}) },
            to: [{ address: to }],
            subject: 'Test message from your form builder',
            text: `This is a test message.\n\nThe email sender "${sender.name}" delivered it, so forms that send from it will reach their recipients.\n`,
            senderSecretRef: sender.smtpSecretId,
          });
        }
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        // Only the class of the failure is logged: the error text can name the relay.
        request.log.warn({ code: typeof code === 'string' ? code : undefined, name: (err as Error | undefined)?.name }, 'email sender test message failed');
        error = scrubMailError(err instanceof Error ? err.message : '') || 'The test message could not be sent.';
      }

      const ok = error === null;
      const at = deps.now();
      await withTenant(deps.db, tenant, async (tx) => {
        // Only if the sender still has the relay and the From address that were tested: a save that changed either while the test ran must not be marked verified.
        const recorded = await tx
          .update(emailSenders)
          .set({ verifiedAt: ok ? at : null, lastTestError: error })
          .where(and(eq(emailSenders.id, id), eq(emailSenders.smtpSecretId, sender.smtpSecretId), eq(emailSenders.fromAddress, sender.fromAddress)))
          .returning({ id: emailSenders.id });
        if (recorded.length === 0) {
          const [still] = await tx.select({ id: emailSenders.id }).from(emailSenders).where(eq(emailSenders.id, id)).limit(1);
          if (!still) throw new ProblemError('NOT_FOUND', 'That email sender is not in this organisation.');
          throw new ProblemError('EMAIL_SENDER_CHANGED', 'The sender was edited while the test ran. Test it again.');
        }
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'email_sender.tested',
          resourceType: 'email_sender',
          resourceId: id,
          outcome: 'success',
          metadata: { ok, verified: ok },
        });
      });
      return { ok, verifiedAt: ok ? at.toISOString() : null, error };
    },
  );
}
