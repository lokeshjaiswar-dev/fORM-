import { z } from 'zod';
import { ApiUnreachable } from '@/auth/client';
import { orgCall, problemOf, type Reply } from '@/persistence/draftsApi';

/*
 * The org's email senders as the Email senders page and a form's Emails tab use them (WP-1.16, apps/api/src/routes/email-senders.ts):
 * the "from" mailboxes of form emails, each with its own SMTP relay. Every call names its org (`X-FR-Org`). Listing needs
 * `forms.read` (whoever edits a form's emails has to pick a sender); adding, changing, testing and deleting need `org.settings`.
 *
 * The SMTP URL carries the relay's password, so it is write-only: it is sent when a sender is added or its relay replaced, and
 * no call ever returns it. What comes back about the relay is its host, port, TLS mode and user name (`smtp`), and only to
 * a caller with `org.settings`.
 */

const smtpSchema = z.object({ host: z.string(), port: z.number().int(), secure: z.boolean(), username: z.string().nullable() });

/** What a sender points at, without the password. */
export type SmtpMeta = z.infer<typeof smtpSchema>;

const senderSchema = z.object({
  id: z.string(),
  name: z.string(),
  fromAddress: z.string(),
  fromName: z.string().nullable(),
  /** When a test message last went through this sender; null while it is untested or after a change to its address or relay. */
  verifiedAt: z.string().nullable(),
  /** Null for a caller without `org.settings`. */
  smtp: smtpSchema.nullable(),
  /** What the last failed test said, scrubbed by the server. Null for a caller without `org.settings`. */
  lastTestError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** An email sender as the API shows it: never with the SMTP URL. */
export type EmailSender = z.infer<typeof senderSchema>;

/** The result of a test message. A failed test is an answer (`ok: false`), not an error. */
const testSchema = z.object({ ok: z.boolean(), verifiedAt: z.string().nullable(), error: z.string().nullable() });
export type TestResult = z.infer<typeof testSchema>;

const permissionsSchema = z.object({ permissions: z.array(z.string()) });

/** What adding a sender takes. */
export interface NewSender {
  name: string;
  fromAddress: string;
  /** The name shown beside the address; left out for none. */
  fromName?: string | undefined;
  /** `smtp://` or `smtps://` with the credentials in it. Sent once and sealed by the server. */
  smtpUrl: string;
}

/** What changing a sender takes: any of them. `smtpUrl` replaces the relay (the old credentials are deleted); `fromName: null` clears the name. */
export interface SenderChange {
  name?: string | undefined;
  fromAddress?: string | undefined;
  fromName?: string | null | undefined;
  smtpUrl?: string | undefined;
}

/** The permission that lets a member add, change, test and delete senders; the API checks it again on every call. */
export const SENDERS_PERMISSION = 'org.settings';

function read<T>(reply: Reply, schema: z.ZodType<T>): T {
  if (!reply.ok) throw problemOf(reply);
  const parsed = schema.safeParse(reply.json);
  if (!parsed.success) throw new ApiUnreachable();
  return parsed.data;
}

const one = (id: string) => `/v1/email-senders/${encodeURIComponent(id)}`;

/** Whether the member's role in `org` carries `org.settings` (`GET /v1/org` lists what it grants). */
export async function canManageSenders(org: string): Promise<boolean> {
  return read(await orgCall(org, 'GET', '/v1/org'), permissionsSchema).permissions.includes(SENDERS_PERMISSION);
}

/** The org's senders, oldest first. */
export async function listEmailSenders(org: string): Promise<EmailSender[]> {
  return read(await orgCall(org, 'GET', '/v1/email-senders'), z.object({ items: z.array(senderSchema) })).items;
}

/** Adds a sender. It is unverified until a test message has gone through it. */
export async function addEmailSender(org: string, sender: NewSender): Promise<EmailSender> {
  const body = { name: sender.name, fromAddress: sender.fromAddress, ...(sender.fromName ? { fromName: sender.fromName } : {}), smtpUrl: sender.smtpUrl };
  return read(await orgCall(org, 'POST', '/v1/email-senders', body), senderSchema);
}

/** Changes a sender. A new address or relay clears its verified state: nothing has gone through the new combination yet. */
export async function changeEmailSender(org: string, id: string, change: SenderChange): Promise<EmailSender> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(change)) if (value !== undefined) body[key] = value;
  return read(await orgCall(org, 'PATCH', one(id), body), senderSchema);
}

/** Deletes a sender and its sealed credentials. One that a notification still sends from is a 409 (`EMAIL_SENDER_IN_USE`). */
export async function deleteEmailSender(org: string, id: string): Promise<void> {
  const reply = await orgCall(org, 'DELETE', one(id));
  if (!reply.ok) throw problemOf(reply);
}

/** Sends one message through the sender to the signed-in member's own address (never to an address in the request). */
export async function testEmailSender(org: string, id: string): Promise<TestResult> {
  return read(await orgCall(org, 'POST', `${one(id)}/test`, {}), testSchema);
}
