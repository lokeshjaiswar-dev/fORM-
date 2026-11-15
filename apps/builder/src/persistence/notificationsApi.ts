import { z } from 'zod';
import { NotificationConfigSchema, type NotificationConfig } from '@form/schema';
import { ApiUnreachable } from '@/auth/client';
import { orgCall, problemOf, type Reply } from '@/persistence/draftsApi';

/*
 * The notifications API as the form settings' Emails and Email log tabs use it (WP-1.16, apps/api/src/routes/notifications.ts):
 * a form's notifications and autoresponders, and the log of the emails sent for it. Every call names its org (`X-FR-Org`).
 * Reading needs `forms.read` (the log needs `submissions.read`, because it says who a response's data was emailed to), writing
 * `forms.edit`; a save that routes answers to someone outside the people who may already read them also needs `data.route`.
 *
 * A notification is live and unversioned: a save names the revision it read in `If-Match`, and a stale one is a conflict
 * rather than an overwrite. The server makes the id; the body is a `NotificationConfig`, which the server parses with the same
 * strict schema this module reads with.
 */

const warningSchema = z.object({
  code: z.string(),
  /** Where in the notification (a JSON pointer into the config). */
  path: z.string(),
  blockId: z.string(),
  message: z.string(),
});

/** Something wrong with a saved notification that did not stop it being saved (a field the form no longer has). */
export type NotificationWarning = z.infer<typeof warningSchema>;

const notificationSchema = z.object({
  id: z.string(),
  formId: z.string(),
  /** The revision to send back in `If-Match`. */
  rev: z.number().int().min(1),
  config: NotificationConfigSchema,
  warnings: z.array(warningSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** A notification as the API holds it, with the revision to save it at. */
export type Notification = z.infer<typeof notificationSchema>;

const MESSAGE_STATUSES = ['queued', 'sending', 'retrying', 'sent', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export { MESSAGE_STATUSES };

const logItemSchema = z.object({
  id: z.string(),
  notificationId: z.string(),
  submissionId: z.string(),
  /** Why this person is a recipient (`to`, `cc`, `bcc`). */
  role: z.string(),
  /** Masked addresses, as the worker stored them (`a***@example.com`): the log never holds a full one. */
  to: z.array(z.string()),
  status: z.enum(MESSAGE_STATUSES),
  attempts: z.number().int().min(0),
  /** The mail server's last complaint, scrubbed by the worker. */
  lastError: z.string().nullable(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
});

/** One email the worker made for a response, with how its delivery went. */
export type EmailLogItem = z.infer<typeof logItemSchema>;

const logSchema = z.object({ items: z.array(logItemSchema), nextCursor: z.string().nullable() });

/** One page of the email log, newest first; `nextCursor` is null on the last page. */
export type EmailLogPage = z.infer<typeof logSchema>;

const memberSchema = z.object({ userId: z.string(), email: z.string(), name: z.string().nullable(), role: z.string(), status: z.string() });
const membersSchema = z.object({ items: z.array(memberSchema) });

/** A member of the org, as the recipient picker lists them. */
export type OrgMember = z.infer<typeof memberSchema>;

/** Someone saved the notification first (409 `NOTIFICATION_REV_CONFLICT`): nothing was written; read it again. */
export class NotificationConflict extends Error {
  constructor() {
    super('The notification changed since it was read.');
    this.name = 'NotificationConflict';
  }
}

/** The refusals that belong next to a part of the editor rather than in a banner. */
export type RefusalCode = 'MISSING_PURPOSE' | 'DATA_ROUTE_FORBIDDEN' | 'SENDER_NOT_FOUND' | 'RECIPIENT_NOT_FOUND' | 'NOTIFICATION_INVALID';

const REFUSALS: ReadonlySet<string> = new Set<RefusalCode>(['MISSING_PURPOSE', 'DATA_ROUTE_FORBIDDEN', 'SENDER_NOT_FOUND', 'RECIPIENT_NOT_FOUND', 'NOTIFICATION_INVALID']);

/**
 * The server refused a save for a reason about one part of the notification: no purpose, or one the form does not declare
 * (422 `MISSING_PURPOSE`); a recipient that needs `data.route` the caller lacks (403 `DATA_ROUTE_FORBIDDEN`); a sender or
 * member that is not the org's (422); or a body the strict schema refused (422 `NOTIFICATION_INVALID`, with `fields`).
 * Nothing was written. `detail` is the server's own sentence.
 */
export class NotificationRefused extends Error {
  readonly code: RefusalCode;
  readonly fields: Array<{ path: string; message: string }>;
  constructor(code: RefusalCode, detail: string, fields: Array<{ path: string; message: string }> = []) {
    super(detail);
    this.name = 'NotificationRefused';
    this.code = code;
    this.fields = fields;
  }
}

function read<T>(reply: Reply, schema: z.ZodType<T>): T {
  if (!reply.ok) throw problemOf(reply);
  const parsed = schema.safeParse(reply.json);
  if (!parsed.success) throw new ApiUnreachable();
  return parsed.data;
}

/** The refusal a reply carries when it is one the editor shows inline, else null (the caller throws the plain problem). */
function refusalOf(reply: Reply): NotificationRefused | null {
  if (reply.ok || reply.json === null || typeof reply.json !== 'object') return null;
  const body = reply.json as { code?: unknown; detail?: unknown; title?: unknown; errors?: unknown };
  if (typeof body.code !== 'string' || !REFUSALS.has(body.code)) return null;
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const fields = errors.flatMap((e): Array<{ path: string; message: string }> => {
    const entry = e as { path?: unknown; message?: unknown };
    return typeof entry.path === 'string' && typeof entry.message === 'string' ? [{ path: entry.path, message: entry.message }] : [];
  });
  const detail = typeof body.detail === 'string' ? body.detail : typeof body.title === 'string' ? body.title : '';
  return new NotificationRefused(body.code as RefusalCode, detail, fields);
}

const base = (formId: string) => `/v1/forms/${encodeURIComponent(formId)}`;
const one = (formId: string, id: string) => `${base(formId)}/notifications/${encodeURIComponent(id)}`;

/** A form's notifications, oldest first (at most 25: there is no cursor). A form that is not on the server yet is a 404. */
export async function listNotifications(org: string, formId: string): Promise<Notification[]> {
  return read(await orgCall(org, 'GET', `${base(formId)}/notifications`), z.object({ items: z.array(notificationSchema) })).items;
}

function written(reply: Reply): Notification {
  const refusal = refusalOf(reply);
  if (refusal) throw refusal;
  return read(reply, notificationSchema);
}

/** A notification as the editor holds it: the config without its id, which the server makes. */
export type NotificationForm = Omit<NotificationConfig, 'id'>;

/** Adds a notification. The server makes its id and answers it at revision 1; the client never picks one. */
export async function createNotification(org: string, formId: string, config: NotificationForm): Promise<Notification> {
  return written(await orgCall(org, 'POST', `${base(formId)}/notifications`, config));
}

/**
 * Saves a notification if the server is still at revision `rev` (`If-Match`): a stale revision is `NotificationConflict`, a
 * refusal about one part of it `NotificationRefused`. The answer is the notification as saved, with its new revision.
 */
export async function saveNotification(org: string, formId: string, id: string, config: NotificationForm, rev: number): Promise<Notification> {
  const reply = await orgCall(org, 'PUT', one(formId, id), { ...config, id }, { 'if-match': `"${rev}"` });
  if (reply.status === 409 && (reply.json as { code?: unknown } | null)?.code === 'NOTIFICATION_REV_CONFLICT') throw new NotificationConflict();
  return written(reply);
}

/** Removes a notification. Messages already queued for it still go out; its entries in the log stay. */
export async function deleteNotification(org: string, formId: string, id: string): Promise<void> {
  const reply = await orgCall(org, 'DELETE', one(formId, id));
  if (!reply.ok) throw problemOf(reply);
}

/** The members of the org that a notification can be addressed to (`GET /v1/org/members`, `forms.read`). */
export async function listOrgMembers(org: string): Promise<OrgMember[]> {
  return read(await orgCall(org, 'GET', '/v1/org/members'), membersSchema).items;
}

/** One page of a form's email log (`submissions.read`), newest first. Pass the previous page's `nextCursor` unchanged for the next one. */
export async function listEmailLog(org: string, formId: string, o: { status?: MessageStatus | undefined; cursor?: string | undefined; limit?: number | undefined } = {}): Promise<EmailLogPage> {
  const query = new URLSearchParams();
  if (o.limit !== undefined) query.set('limit', String(o.limit));
  if (o.status) query.set('status', o.status);
  if (o.cursor) query.set('cursor', o.cursor);
  const q = query.toString();
  return read(await orgCall(org, 'GET', `${base(formId)}/email-log${q ? `?${q}` : ''}`), logSchema);
}
