import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, auditActor, emailSenders, formDrafts, forms, isUuid, memberships, notifications, withTenant, type Db, type MembershipRole, type Tx } from '@form/db';
import { canonicalJson, NotificationConfigSchema, type NotificationConfig } from '@form/schema';
import { accountOf, clientInfo, tenantOf } from '../auth.ts';
import { permissionsFor } from '../authz/roles.ts';
import { ProblemError, sendProblem, type FieldIssue } from '../errors.ts';
import { hex } from '../modules/auth/crypto.ts';
import { uuidv7 } from '../uuid7.ts';

export interface NotificationRouteDeps {
  /** The request pool: every read and write goes through `withTenant` on it, so row-level security limits it to the caller's org. */
  db: Db;
  /** The small separate pool for denied and failed audit records (ADR-0006). */
  auditDb: Db;
  /** Keys the IP hash of audit records (`config.auth.secret`). */
  secret: Uint8Array;
  now: () => Date;
}

const SECURITY = [{ session: [], org: [] }, { devUser: [], org: [] }];
const TAGS = ['notifications'];
const isoInstant = z.iso.datetime({ offset: true });
const formParam = z.object({ formId: z.uuid() });
const notificationParams = z.object({ formId: z.uuid(), id: z.uuid() });

/** A form's emails stay a short list: every enabled one costs a job per response (`notification.dispatch`). */
export const MAX_NOTIFICATIONS_PER_FORM = 25;
const MAX_WARNINGS = 50;
const MAX_WALK_DEPTH = 40;

const warningView = z.object({
  code: z.enum(['unknown_recipient_field', 'unknown_merge_tag_block']),
  /** Where in the notification (a JSON pointer into the config). */
  path: z.string(),
  blockId: z.string(),
  message: z.string(),
});
export type NotificationWarning = z.infer<typeof warningView>;

const notificationView = z.object({
  id: z.uuid(),
  formId: z.uuid(),
  /** The revision to send back in `If-Match` (also the `ETag`). */
  rev: z.number().int().min(1),
  /** The stored `NotificationConfig`; `id`, `kind`, `trigger`, `enabled`, `senderId` and `purposeIds` always agree with the columns the worker reads. */
  config: z.record(z.string(), z.unknown()),
  /** Things that are wrong but do not stop a save (a field the form no longer has). Computed from the draft at read time. */
  warnings: z.array(warningView),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
type NotificationView = z.infer<typeof notificationView>;

/** Loose on purpose: the body is parsed with the strict twin in the handler, so a bad one is a 422 with paths. */
const configBody = z.record(z.string(), z.unknown());

/** The revision a save read, from `If-Match` (`3`, `"3"` or `W/"3"`). */
function expectedRev(request: FastifyRequest): number {
  const header = request.headers['if-match'];
  const m = typeof header === 'string' ? /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(header) : null;
  if (!m) throw new ProblemError('NOTIFICATION_REV_REQUIRED', 'Send the revision you read (the rev of the notification) in If-Match.');
  return Number(m[1]);
}

const etag = (rev: number): string => `"${rev}"`;

/** Postgres `foreign_key_violation`, whether the driver error is bare or wrapped by drizzle. */
function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return e?.code === '23503' || e?.cause?.code === '23503';
}

/**
 * The sender that `check` found was deleted before the write got to it: the foreign key is the last word, and the answer
 * is the one `check` gives for a sender that is not there.
 */
function senderGone(err: unknown): unknown {
  return isForeignKeyViolation(err) ? new ProblemError('SENDER_NOT_FOUND', 'That email sender was deleted while you were saving.') : err;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first few problems the strict twin found, as field issues (paths are JSON pointers, like the draft's). */
function issuesOf(error: z.ZodError): FieldIssue[] {
  return error.issues.slice(0, 20).map((issue) => ({ path: `/${issue.path.map(String).join('/')}`.replace(/\/$/, '') || '/', message: issue.message }));
}

// ---------------------------------------------------------------------------------------------------------------
// What the form's draft says: the purposes it declares and the blocks it has
// ---------------------------------------------------------------------------------------------------------------

interface DraftFacts {
  purposeIds: ReadonlySet<string>;
  blockIds: ReadonlySet<string>;
}

/**
 * The ids a notification may name, from the draft (not the live version: a notification is live and unversioned, and
 * is written while the form is still being edited). Only two small parts of the draft are read, not the whole definition.
 * A form with no draft yet declares nothing.
 */
async function draftFactsOf(tx: Tx, formId: string): Promise<DraftFacts> {
  const [row] = await tx
    .select({
      purposes: sql<unknown>`case when jsonb_typeof(${formDrafts.draft} #> '{privacy,purposes}') = 'array' then ${formDrafts.draft} #> '{privacy,purposes}' else '[]'::jsonb end`,
      blockIds: sql<string[]>`array(select jsonb_object_keys(case when jsonb_typeof(${formDrafts.draft} -> 'blocks') = 'object' then ${formDrafts.draft} -> 'blocks' else '{}'::jsonb end))`,
    })
    .from(formDrafts)
    .where(eq(formDrafts.formId, formId))
    .limit(1);
  const purposes = Array.isArray(row?.purposes) ? row.purposes : [];
  return {
    purposeIds: new Set(purposes.flatMap((p) => (isRecord(p) && typeof p.id === 'string' ? [p.id] : []))),
    blockIds: new Set(row?.blockIds ?? []),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Warnings: a notification that names a field the form no longer has still saves, and renders that part empty
// ---------------------------------------------------------------------------------------------------------------

/**
 * What is wrong with a notification that does not stop it being saved (delivery-plan D5: "render empty + builder
 * warning"): a recipient that reads an email field, or a merge tag or answers table that names a block, which the form's
 * draft does not have. One warning per block and kind, at most 50. Read from the config as plain JSON, so a stored config
 * that an older version wrote still gets its warnings.
 */
export function warningsOf(config: Record<string, unknown>, blockIds: ReadonlySet<string>): NotificationWarning[] {
  const out: NotificationWarning[] = [];
  const seen = new Set<string>();
  const add = (code: NotificationWarning['code'], path: string, blockId: string, message: string) => {
    const key = `${code}\0${blockId}`;
    if (seen.has(key) || out.length >= MAX_WARNINGS) return;
    seen.add(key);
    out.push({ code, path, blockId, message });
  };
  const checkRecipient = (r: unknown, path: string) => {
    if (isRecord(r) && r.kind === 'field' && typeof r.blockId === 'string' && !blockIds.has(r.blockId)) {
      add('unknown_recipient_field', path, r.blockId, 'The field this email is sent to is not in the form any more, so nobody is emailed through it.');
    }
  };
  for (const key of ['to', 'cc', 'bcc'] as const) {
    const list = config[key];
    if (Array.isArray(list)) list.forEach((r, i) => checkRecipient(r, `/${key}/${i}`));
  }
  checkRecipient(config.replyTo, '/replyTo');

  const check = (blockId: unknown, path: string) => {
    if (typeof blockId === 'string' && !blockIds.has(blockId)) add('unknown_merge_tag_block', path, blockId, 'This email uses a field that is not in the form any more; that part is left empty.');
  };
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > MAX_WALK_DEPTH || out.length >= MAX_WARNINGS) return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}/${i}`, depth + 1));
      return;
    }
    if (!isRecord(v)) return;
    // A pipe's source (`{ kind: 'answer', blockId }`), a delay that follows a date field and the PDF password field.
    check(v.blockId, `${path}/blockId`);
    check(v.fromBlockId, `${path}/fromBlockId`);
    if (v.type === 'answersTable' && isRecord(v.attrs) && Array.isArray(v.attrs.include)) v.attrs.include.forEach((id, i) => check(id, `${path}/attrs/include/${i}`));
    for (const [k, x] of Object.entries(v)) walk(x, `${path}/${k}`, depth + 1);
  };
  for (const [k, v] of Object.entries(config)) {
    if (k === 'to' || k === 'cc' || k === 'bcc' || k === 'replyTo') continue;
    walk(v, `/${k}`, 0);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Who the answers go to, and what that needs
// ---------------------------------------------------------------------------------------------------------------

interface Routed {
  /** Where in the config (`/to/0`): the only way a refusal names a recipient, because an address never goes in an error. */
  path: string;
  /** The same person or address in two saves has the same key, so a save is compared with the one before it. */
  key: string;
  /** Outside the people who may already read the answers: needs `data.route`. */
  external: boolean;
}

const RECIPIENT_LISTS = ['to', 'cc', 'bcc'] as const;

/** Every recipient of a notification in the order they are listed, as plain JSON (the stored config is read leniently). */
function recipientsOf(config: Record<string, unknown>): Array<{ path: string; recipient: Record<string, unknown> }> {
  const out: Array<{ path: string; recipient: Record<string, unknown> }> = [];
  for (const key of RECIPIENT_LISTS) {
    const list = config[key];
    if (Array.isArray(list)) list.forEach((r, i) => isRecord(r) && out.push({ path: `/${key}/${i}`, recipient: r }));
  }
  if (isRecord(config.replyTo)) out.push({ path: '/replyTo', recipient: config.replyTo });
  return out;
}

/** The stable identity of a recipient, without looking anything up: what a later save is compared with. */
function keyOf(r: Record<string, unknown>): string {
  switch (r.kind) {
    case 'email':
      return `email:${String(r.address).toLowerCase()}`;
    case 'field':
      return `field:${String(r.blockId)}`;
    case 'member':
      return `member:${String(r.userId).toLowerCase()}`;
    default:
      return `role:${String(r.role)}`;
  }
}

/** Whether a member of this role may read the org's answers: the one thing that keeps an answer inside the org's own readers. */
const mayReadAnswers = (role: MembershipRole): boolean => permissionsFor(role).includes('submissions.read');

/**
 * Which recipients are outside the people who may already read the answers (CONTRIBUTING rule 6: an outside recipient is a
 * disclosure). A fixed address is; a member is when their role cannot read answers (or they are suspended); the form's owner
 * is when their role cannot; the org's admins are not; a field the respondent filled in (the autoresponder) is not, because
 * it is the respondent's own answer going back to them. A `member` that is not an active member of this org at all is
 * `RECIPIENT_NOT_FOUND`: another org's user id looks exactly like one that never existed.
 */
async function routedOf(tx: Tx, formId: string, config: Record<string, unknown>): Promise<Routed[]> {
  const list = recipientsOf(config);
  const memberIds = list.flatMap(({ recipient }) => (recipient.kind === 'member' && typeof recipient.userId === 'string' ? [recipient.userId.toLowerCase()] : []));
  const needsOwner = list.some(({ recipient }) => recipient.kind === 'role' && recipient.role === 'form_owner');
  const [form] = needsOwner ? await tx.select({ owner: forms.ownerUserId }).from(forms).where(eq(forms.id, formId)).limit(1) : [];
  // An id that is not a uuid is no member, and Postgres would answer a uuid column compared with one by raising.
  const ids = [...new Set([...memberIds.filter((id) => isUuid(id)), ...(form ? [form.owner] : [])])];
  const people = new Map<string, { role: MembershipRole; status: string }>();
  if (ids.length > 0) {
    const rows = await tx.select({ userId: memberships.userId, role: memberships.role, status: memberships.status }).from(memberships).where(inArray(memberships.userId, ids));
    for (const row of rows) people.set(row.userId, { role: row.role, status: row.status });
  }
  return list.map(({ path, recipient }) => {
    const key = keyOf(recipient);
    switch (recipient.kind) {
      case 'email':
        return { path, key, external: true };
      case 'field':
        return { path, key, external: false };
      case 'member': {
        const person = typeof recipient.userId === 'string' ? people.get(recipient.userId.toLowerCase()) : undefined;
        if (!person) throw new ProblemError('RECIPIENT_NOT_FOUND', `The member at ${path} is not in this organisation.`);
        return { path, key, external: person.status !== 'active' || !mayReadAnswers(person.role) };
      }
      default: {
        if (recipient.role !== 'form_owner') return { path, key, external: false };
        const owner = form ? people.get(form.owner) : undefined;
        return { path, key, external: !owner || owner.status !== 'active' || !mayReadAnswers(owner.role) };
      }
    }
  });
}

/** Whether a notification carries the respondent's files or a PDF of the answers: an attachment is a disclosure like a recipient. */
function carriesAnswerFiles(config: Record<string, unknown>): boolean {
  const a = config.attachments;
  return isRecord(a) && ((typeof a.uploads === 'string' && a.uploads !== 'none') || isRecord(a.pdf));
}

/**
 * What this save routes that the stored notification did not (empty for a new one: everything it routes is new). Each is a
 * disclosure that `data.route` exists to gate (architecture §2.4: it closes the path where a creator, who may not read
 * answers, sends future answers to themselves):
 *  - a recipient outside the people who may read answers that the stored notification did not have;
 *  - more purposes than before, while any recipient is outside those people (the purposes decide which answers they get);
 *  - the respondent's files or a PDF of the answers, which the stored notification did not carry.
 * Editing the subject or the text, removing a recipient, narrowing the purposes and disabling the notification route
 * nothing new, so a creator may do them to a notification an editor set up.
 */
export function newRouting(o: { before: Record<string, unknown> | null; beforePurposes: readonly string[]; after: Record<string, unknown>; afterPurposes: readonly string[]; routed: readonly Routed[] }): string[] {
  const had = new Set(o.before ? recipientsOf(o.before).map(({ recipient }) => keyOf(recipient)) : []);
  const reasons: string[] = [];
  const added = o.routed.filter((r) => r.external && !had.has(r.key));
  if (added.length > 0) reasons.push(`a recipient outside the people who may read answers (${added.map((r) => r.path).join(', ')})`);
  // A new notification has no stored purposes to widen: its outside recipients are the disclosure, already counted above.
  if (o.before && o.routed.some((r) => r.external) && o.afterPurposes.some((p) => !o.beforePurposes.includes(p))) reasons.push('more purposes sent to a recipient outside the people who may read answers');
  if (carriesAnswerFiles(o.after) && !(o.before && carriesAnswerFiles(o.before))) reasons.push("the respondent's files or a PDF of the answers");
  return reasons;
}

// ---------------------------------------------------------------------------------------------------------------
// Rows and views
// ---------------------------------------------------------------------------------------------------------------

const rowColumns = {
  id: notifications.id,
  formId: notifications.formId,
  config: notifications.config,
  purposeIds: notifications.purposeIds,
  rev: notifications.rev,
  createdAt: notifications.createdAt,
  updatedAt: notifications.updatedAt,
};
type Row = { id: string; formId: string; config: Record<string, unknown>; purposeIds: string[]; rev: number; createdAt: Date; updatedAt: Date };

function viewOf(row: Row, blockIds: ReadonlySet<string>): NotificationView {
  return {
    id: row.id,
    formId: row.formId,
    rev: row.rev,
    config: row.config,
    warnings: warningsOf(row.config, blockIds),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** RLS limits the read to the caller's org, so a form of another org is as absent as one that never existed. */
async function requireForm(tx: Tx, formId: string, o: { lock?: boolean } = {}): Promise<void> {
  // `no key update` is the strength a draft save takes too; it serialises the creates that count a form's notifications.
  const query = tx.select({ id: forms.id }).from(forms).where(eq(forms.id, formId)).limit(1);
  const [form] = await (o.lock ? query.for('no key update') : query);
  if (!form) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
}

/** The top-level keys of the config that differ, sorted; `id` never differs (it is the row's). */
function changedKeys(before: Record<string, unknown> | null, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  keys.delete('id');
  return [...keys].filter((k) => canonicalJson(before?.[k] ?? null) !== canonicalJson(after[k] ?? null)).sort();
}

/** The columns the worker queries, copied from the config, so the two can never disagree (the config is the one input). */
function columnsOf(config: NotificationConfig) {
  return {
    kind: config.kind,
    enabled: config.enabled,
    trigger: config.trigger,
    senderId: config.senderId ?? null,
    config: config as unknown as Record<string, unknown>,
    purposeIds: [...config.purposeIds] as string[],
  };
}

/**
 * The notifications of a form (WP-1.16, NOT-01 to NOT-03): `/v1/forms/:formId/notifications`. A notification is live and unversioned (architecture §2.4): publishing freezes the form,
 * not its emails. The stored `config` is the `NotificationConfig` of `@form/schema`; the server makes the id, so a client
 * cannot pick one that collides with another org's row, and copies `kind`, `trigger`, `enabled`, `senderId` and `purposeIds`
 * into the columns the worker queries.
 *
 * Reading needs `forms.read` and writing `forms.edit`; the table's RLS repeats it. On top of that, a save that routes the
 * answers to someone outside the people who may already read them needs `data.route` (`newRouting`): a 403 that the error
 * handler audits as `request.authorize` denied. A save names the revision it read in `If-Match` (428 without, 409 when
 * stale). Every lookup runs in `withTenant`, so another org's form or notification is a 404. Each route has a case in
 * `test/isolation-cases/notifications.ts`.
 */
export function notificationRoutes(app: FastifyInstance, deps: NotificationRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const client = (request: FastifyRequest) => {
    const info = clientInfo(request, deps.secret, deps.now());
    return { sessionId: accountOf(request).session?.id ?? null, actorIpHash: hex(info.ipHash), actorUa: info.ua };
  };

  /**
   * Everything a create or a save checks before it writes, in the order the caller can act on it: the config parses (422),
   * its purposes are the form's own (422), its sender is the org's (422), its member recipients are the org's (422), and the
   * caller may route to everyone it names (403).
   */
  async function check(tx: Tx, request: FastifyRequest, formId: string, config: NotificationConfig, before: Row | null): Promise<{ external: boolean }> {
    const facts = await draftFactsOf(tx, formId);
    const unknown = config.purposeIds.filter((p) => !facts.purposeIds.has(p));
    if (config.purposeIds.length === 0) {
      throw new ProblemError('MISSING_PURPOSE', 'Name at least one of the purposes this form declares: a notification without one would send every field.');
    }
    if (unknown.length > 0) {
      throw new ProblemError('MISSING_PURPOSE', `The form does not declare ${unknown.length === 1 ? 'this purpose' : 'these purposes'}: ${unknown.join(', ')}.`);
    }
    if (config.senderId !== undefined) {
      const found = isUuid(config.senderId) ? (await tx.select({ id: emailSenders.id }).from(emailSenders).where(eq(emailSenders.id, config.senderId)).limit(1))[0] : undefined;
      if (!found) throw new ProblemError('SENDER_NOT_FOUND', 'Choose one of this organisation’s email senders, or leave the sender out to use the platform’s.');
    }
    const asJson = config as unknown as Record<string, unknown>;
    const routed = await routedOf(tx, formId, asJson);
    const reasons = newRouting({ before: before?.config ?? null, beforePurposes: before?.purposeIds ?? [], after: asJson, afterPurposes: config.purposeIds, routed });
    const tenant = tenantOf(request);
    if (reasons.length > 0 && tenant.perms?.includes('data.route') !== true) {
      throw new ProblemError('DATA_ROUTE_FORBIDDEN', `Saving this email would route answers to ${reasons.join(' and ')}, which needs the data.route permission.`, {
        orgId: tenant.orgId,
        actorId: tenant.userId ?? null,
        reason: 'missing_permission:data.route',
      });
    }
    return { external: routed.some((x) => x.external) };
  }

  /** The strict twin's verdict on a body, with the server's id in place of whatever the client sent. */
  function parseConfig(body: Record<string, unknown>, id: string, o: { idMustMatch: boolean }): { config: NotificationConfig } | { detail: string; issues: FieldIssue[] } {
    if (o.idMustMatch && body.id !== undefined && body.id !== id) {
      return { detail: 'The notification names a different id than the address.', issues: [{ path: '/id', message: 'must equal the id in the address, or be left out' }] };
    }
    const parsed = NotificationConfigSchema.safeParse({ ...body, id });
    if (!parsed.success) return { detail: 'The notification is not a valid notification configuration.', issues: issuesOf(parsed.error) };
    // The same purpose twice is the same purpose.
    return { config: { ...parsed.data, purposeIds: [...new Set(parsed.data.purposeIds)] } };
  }

  const saved = (tx: Tx, request: FastifyRequest, who: ReturnType<typeof client>, o: { formId: string; id: string; change: 'created' | 'updated'; before: Row | null; config: NotificationConfig; rev: number; routed: boolean }) =>
    audit.append(tx, tenantOf(request).orgId, {
      ...auditActor(tenantOf(request)),
      sessionId: who.sessionId,
      actorIpHash: who.actorIpHash,
      actorUa: who.actorUa,
      action: 'notification.saved',
      resourceType: 'notification',
      resourceId: o.id,
      formId: o.formId,
      outcome: 'success',
      metadata: {
        change: o.change,
        kind: o.config.kind,
        trigger: o.config.trigger,
        enabled: o.config.enabled,
        rev: o.rev,
        changedKeys: changedKeys(o.before?.config ?? null, o.config as unknown as Record<string, unknown>),
        recipientCount: recipientsOf(o.config as unknown as Record<string, unknown>).length,
        purposeCount: o.config.purposeIds.length,
        externalRecipients: o.routed,
      },
    });

  r.get(
    '/v1/forms/:formId/notifications',
    {
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags: TAGS,
        summary: "List a form's notifications",
        description:
          'Oldest first. Each carries `warnings` for fields the draft no longer has (the notification still saves; that part renders empty). The list is at most 25 long and has no cursor.',
        security: SECURITY,
        params: formParam,
        response: { 200: z.object({ items: z.array(notificationView) }) },
      },
    },
    async (request, reply) => {
      const { formId } = request.params;
      const { rows, facts } = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, async (tx) => {
        await requireForm(tx, formId);
        return {
          rows: await tx.select(rowColumns).from(notifications).where(eq(notifications.formId, formId)).orderBy(asc(notifications.createdAt), asc(notifications.id)),
          facts: await draftFactsOf(tx, formId),
        };
      });
      reply.header('cache-control', 'private, no-store');
      return { items: rows.map((row) => viewOf(row, facts.blockIds)) };
    },
  );

  r.post(
    '/v1/forms/:formId/notifications',
    {
      config: { auth: 'user', perm: 'forms.edit' },
      schema: {
        tags: TAGS,
        summary: 'Add a notification to a form',
        description:
          'The body is a `NotificationConfig`; the server makes the id (an `id` in the body is ignored). `purposeIds` must name purposes of the form\'s draft (422 `MISSING_PURPOSE`, nothing written), `senderId` one of the org\'s email senders (422 `SENDER_NOT_FOUND`), `member` recipients members of the org (422 `RECIPIENT_NOT_FOUND`). A recipient outside the people who may read answers (a fixed address, a member whose role cannot read answers) needs `data.route`, else 403. Recipients that read a field the draft does not have, and merge tags that name one, are `warnings`, not errors. At most 25 per form. Audited as `notification.saved` (keys only).',
        security: SECURITY,
        params: formParam,
        body: configBody,
        response: { 201: notificationView },
      },
    },
    async (request, reply) => {
      const { formId } = request.params;
      const tenant = tenantOf(request);
      const id = uuidv7();
      const parsed = parseConfig(request.body, id, { idMustMatch: false });
      if (!('config' in parsed)) return sendProblem(reply, 'NOTIFICATION_INVALID', parsed.detail, parsed.issues);
      const { config } = parsed;
      const who = client(request);
      const at = deps.now();
      const out = await withTenant(deps.db, tenant, async (tx) => {
        await requireForm(tx, formId, { lock: true });
        const [existing] = await tx.select({ n: count() }).from(notifications).where(eq(notifications.formId, formId));
        if ((existing?.n ?? 0) >= MAX_NOTIFICATIONS_PER_FORM) throw new ProblemError('PLAN_LIMIT_REACHED', `A form can have ${MAX_NOTIFICATIONS_PER_FORM} notifications.`);
        const { external } = await check(tx, request, formId, config, null);
        const [row] = await tx
          .insert(notifications)
          .values({ id, orgId: tenant.orgId, formId, ...columnsOf(config), rev: 1, createdAt: at, updatedAt: at, updatedBy: accountOf(request).userId })
          .returning(rowColumns);
        await saved(tx, request, who, { formId, id, change: 'created', before: null, config, rev: 1, routed: external });
        return { row: row!, facts: await draftFactsOf(tx, formId) };
      }).catch((err: unknown) => {
        throw senderGone(err);
      });
      reply.header('etag', etag(out.row.rev));
      return reply.code(201).send(viewOf(out.row, out.facts.blockIds));
    },
  );

  r.get(
    '/v1/forms/:formId/notifications/:id',
    {
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags: TAGS,
        summary: 'Read one notification',
        description: 'The `ETag` is the revision to send back in `If-Match` when saving.',
        security: SECURITY,
        params: notificationParams,
        response: { 200: notificationView },
      },
    },
    async (request, reply) => {
      const { formId, id } = request.params;
      const { row, facts } = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, async (tx) => {
        const [found] = await tx.select(rowColumns).from(notifications).where(and(eq(notifications.id, id), eq(notifications.formId, formId))).limit(1);
        if (!found) throw new ProblemError('NOT_FOUND', 'That notification is not in this organisation.');
        return { row: found, facts: await draftFactsOf(tx, formId) };
      });
      reply.header('etag', etag(row.rev)).header('cache-control', 'private, no-store');
      return viewOf(row, facts.blockIds);
    },
  );

  r.put(
    '/v1/forms/:formId/notifications/:id',
    {
      config: { auth: 'user', perm: 'forms.edit' },
      schema: {
        tags: TAGS,
        summary: 'Save a notification',
        description:
          'Replaces the notification (a key left out is cleared) if `If-Match` names the revision that was read, else 409 `NOTIFICATION_REV_CONFLICT`; without it, 428. The same checks as creating one, and `data.route` is needed only for what this save newly routes: a recipient outside the people who may read answers that the stored notification did not have, more purposes while one is there, or the respondent\'s files or a PDF. Editing the text, removing a recipient, narrowing the purposes or disabling needs only `forms.edit`.',
        security: SECURITY,
        params: notificationParams,
        body: configBody,
        response: { 200: notificationView },
      },
    },
    async (request, reply) => {
      const { formId, id } = request.params;
      const tenant = tenantOf(request);
      const expected = expectedRev(request);
      const parsed = parseConfig(request.body, id, { idMustMatch: true });
      if (!('config' in parsed)) return sendProblem(reply, 'NOTIFICATION_INVALID', parsed.detail, parsed.issues);
      const { config } = parsed;
      const who = client(request);
      const out = await withTenant(deps.db, tenant, async (tx) => {
        // Locked, so two saves of one notification take turns and the second sees the first's revision.
        const [before] = await tx.select(rowColumns).from(notifications).where(and(eq(notifications.id, id), eq(notifications.formId, formId))).limit(1).for('update');
        if (!before) throw new ProblemError('NOT_FOUND', 'That notification is not in this organisation.');
        const stale = () => new ProblemError('NOTIFICATION_REV_CONFLICT', 'The notification changed since you read it. Reload it and apply your change again.');
        if (before.rev !== expected) throw stale();
        const { external } = await check(tx, request, formId, config, before);
        const [row] = await tx
          .update(notifications)
          .set({ ...columnsOf(config), rev: sql`${notifications.rev} + 1`, updatedAt: deps.now(), updatedBy: accountOf(request).userId })
          .where(and(eq(notifications.id, id), eq(notifications.rev, before.rev)))
          .returning(rowColumns);
        if (!row) throw stale();
        await saved(tx, request, who, { formId, id, change: 'updated', before, config, rev: row.rev, routed: external });
        return { row, facts: await draftFactsOf(tx, formId) };
      }).catch((err: unknown) => {
        throw senderGone(err);
      });
      reply.header('etag', etag(out.row.rev));
      return viewOf(out.row, out.facts.blockIds);
    },
  );

  r.delete(
    '/v1/forms/:formId/notifications/:id',
    {
      config: { auth: 'user', perm: 'forms.edit' },
      schema: {
        tags: TAGS,
        summary: 'Delete a notification',
        description:
          'Needs only `forms.edit`: removing a recipient routes nothing. Messages already queued for it still go out; its entries in the email log stay. Audited as `notification.deleted` (kind and trigger, never the recipients).',
        security: SECURITY,
        params: notificationParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const { formId, id } = request.params;
      const tenant = tenantOf(request);
      const who = client(request);
      await withTenant(deps.db, tenant, async (tx) => {
        const [gone] = await tx
          .delete(notifications)
          .where(and(eq(notifications.id, id), eq(notifications.formId, formId)))
          .returning({ kind: notifications.kind, trigger: notifications.trigger });
        if (!gone) throw new ProblemError('NOT_FOUND', 'That notification is not in this organisation.');
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'notification.deleted',
          resourceType: 'notification',
          resourceId: id,
          formId,
          outcome: 'success',
          metadata: { kind: gone.kind, trigger: gone.trigger },
        });
      });
      return reply.code(204).send(null);
    },
  );

}
