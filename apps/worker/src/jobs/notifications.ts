import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { disclosures, emailMessages, emailSenders, forms, isUuid, notifications, txExecutor, uuidV7Time, type Tx } from '@form/db';
import { JOB_POLICIES, PortError, isPortError, toIsoInstant, type MailMessage, type SubmissionEvent } from '@form/ports';
import { NotificationConfigSchema, type NotificationConfig } from '@form/schema';
import { disclosableFields, disclosedFieldKeys, recordDisclosure, type DisclosableField } from '../effects/disclosure.ts';
import type { EffectDeps } from '../effects/deps.ts';
import { deliveredTo, maskAddress, resolveRecipients, type ResolvedRecipients } from '../effects/email/recipients.ts';
import { renderEmail, renderLine, replaceControls, selectVariant, type EmailRenderOptions, type RenderedEmail } from '../effects/email/render.ts';
import { loadSubmission, type LoadedSubmission } from '../effects/submission.ts';
import { defineJob, type AnyJobDefinition } from './define.ts';
import type { FanoutConsumer } from './submission-fanout.ts';

/*
 * Notifications (WP-1.16, NOT-01..05): the owner notification and the autoresponder a form sends for a stored response.
 *
 *   submission.fanout --(notificationsConsumer)--> notification.dispatch (one per enabled notification of the form)
 *   notification.dispatch --> an `email_messages` row (queued), a `disclosures` row, and `email.send`
 *   email.send --> the mailer; the row ends `sent` or `failed`, or stays `retrying` while the queue tries again
 *
 * Why three steps. The consumer runs inside the fan-out transaction and only enqueues, so a notification that cannot be
 * rendered fails by itself and never holds up a webhook. The dispatch decides WHO gets WHAT and writes it down (the delivery
 * log and the disclosures ledger) in the same transaction that enqueues the send, so there is no email without a log row and
 * no log row whose send was lost. The send holds no database connection while it talks to the SMTP server.
 *
 * Why the message is rendered again at send time. The log keeps no body (it would hold the answers for 365 days). A retry hours
 * later therefore renders from the response and the notification as they are then, through the same `disclosableFields`
 * filter, so an answer the owner has since marked sensitive, or a purpose they have since taken away, is not sent by a retry
 * that was queued before the change. The disclosures row is written at dispatch; if the render at send time would disclose a
 * field the ledger does not yet name, the send adds a row for it first.
 *
 * Delivery is at-least-once. The Message-ID is made once, at dispatch (`<email_messages.id@MESSAGE_ID_DOMAIN>`), and every
 * retry sends the same one, so a message delivered twice because the answer of the mail server was lost is one message to the
 * recipient's mail client. Nothing here logs an address, a subject or a body.
 */

/** The notification trigger a fan-out event belongs to. A response released after review is, for a notification, the response arriving. */
const TRIGGER_OF_EVENT: Record<SubmissionEvent, 'submitted' | 'edited'> = { created: 'submitted', released: 'submitted', updated: 'edited' };

/** The queues this domain works. */
export function notificationJobs(deps: EffectDeps): AnyJobDefinition[] {
  return [notificationDispatch(deps), emailSend(deps)];
}

/**
 * The `submission.fanout` consumer of this domain: one `notification.dispatch` per enabled notification of the form whose
 * trigger matches the event. Only the immediate ones (`delay` none or absent) go now; a delayed notification (NOT-09) waits for
 * the scheduler of WP-2.16 and is counted in the log, not sent early. The children are enqueued through the fan-out's
 * transaction, so they exist exactly when the fan-out commits; a retried fan-out enqueues them again from a rolled-back start,
 * and a fan-out delivered twice is caught by the dispatch (one message per response and notification).
 */
export function notificationsConsumer(deps: EffectDeps): FanoutConsumer {
  return async (target, { tx, log, signal }) => {
    if (target.status !== 'complete') return;
    const trigger = TRIGGER_OF_EVENT[target.event];
    const rows = await tx
      .select({ id: notifications.id, delayKind: sql<string | null>`${notifications.config} #>> '{delay,kind}'` })
      .from(notifications)
      .where(and(eq(notifications.formId, target.formId), eq(notifications.enabled, true), eq(notifications.trigger, trigger)))
      .orderBy(notifications.createdAt, notifications.id);
    if (rows.length === 0) return;
    // The response's id carries its received-at (UUIDv7): the job's key needs it and the database never disagrees with it.
    const receivedAt = uuidV7Time(target.submissionId);
    if (!receivedAt) {
      log.warn({ submissionId: target.submissionId }, 'notifications: the response id is not a UUIDv7; nothing to dispatch');
      return;
    }
    let delayed = 0;
    for (const row of rows) {
      signal.throwIfAborted();
      if (row.delayKind !== null && row.delayKind !== 'none') {
        delayed += 1;
        continue;
      }
      await deps.queue.send(
        'notification.dispatch',
        {
          orgId: target.orgId,
          resource: { type: 'form', id: target.formId },
          data: { submissionId: target.submissionId, receivedAt: toIsoInstant(receivedAt), notificationId: row.id },
        },
        { tx: txExecutor(tx) },
      );
    }
    log.debug({ submissionId: target.submissionId, trigger, dispatched: rows.length - delayed, delayed }, 'notifications: dispatches enqueued');
  };
}

// ─── reading a notification ───────────────────────────────────────────────────────────────────────────────────

interface NotificationRow {
  id: string;
  formId: string;
  kind: string;
  enabled: boolean;
  trigger: string;
  senderId: string | null;
  config: unknown;
  purposeIds: string[];
}

async function readNotification(tx: Tx, formId: string, id: string): Promise<NotificationRow | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await tx
    .select({
      id: notifications.id,
      formId: notifications.formId,
      kind: notifications.kind,
      enabled: notifications.enabled,
      trigger: notifications.trigger,
      senderId: notifications.senderId,
      config: notifications.config,
      purposeIds: notifications.purposeIds,
    })
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.formId, formId)))
    .limit(1);
  return row;
}

/** The notification's config as the contract type. A stored config that no longer parses is a bug to see, so the job fails (its paths are logged, never its values). */
function parseConfig(row: NotificationRow): NotificationConfig {
  const parsed = NotificationConfigSchema.safeParse(row.config);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))].slice(0, 10);
    throw new Error(`notification ${row.id}: the stored config is not a valid NotificationConfig (${paths.join(', ')})`);
  }
  return parsed.data as NotificationConfig;
}

interface Composed {
  config: NotificationConfig;
  fields: DisclosableField[];
  recipients: ResolvedRecipients;
  rendered: RenderedEmail;
  /** The sender's display name from the notification's `fromName` template, or '' when it has none. */
  fromName: string;
  options: EmailRenderOptions;
}

/**
 * What one notification says to one response, now: the answers it may disclose, the people it goes to and the rendered
 * message. The dispatch and the send both call this, so what is logged at dispatch and what is sent are made the same way.
 * The notification's purposes are the stricter of the column the database enforces and the copy in `config`.
 */
async function compose(deps: EffectDeps, tx: Tx, orgId: string, row: NotificationRow, loaded: LoadedSubmission): Promise<Composed> {
  const config = parseConfig(row);
  const purposeIds = row.purposeIds.filter((p) => (config.purposeIds as string[]).includes(p));
  const fields = disclosableFields({
    definition: loaded.definition,
    compiled: loaded.compiled,
    answers: loaded.row.answers,
    purposeIds,
    channel: 'notification',
    sensitiveOverride: config.sensitiveOverride,
  });
  const recipients = await resolveRecipients(tx, config, { orgId, formId: loaded.row.formId, fields });
  const [form] = await tx.select({ title: forms.title }).from(forms).where(eq(forms.id, loaded.row.formId)).limit(1);
  const respondentLocale = typeof loaded.row.meta.locale === 'string' ? loaded.row.meta.locale : undefined;
  const variant = selectVariant(config, respondentLocale);
  const options: EmailRenderOptions = {
    publicBuilderUrl: deps.config.publicBuilderUrl,
    formId: loaded.row.formId,
    formTitle: form?.title ?? '',
    submissionId: loaded.row.id,
    receivedAt: loaded.row.receivedAt,
    locale: variant.locale,
  };
  return {
    config,
    fields,
    recipients,
    rendered: renderEmail(variant.body, variant.subject, fields, options),
    fromName: config.fromName ? renderLine(config.fromName, fields, options) : '',
    options,
  };
}

const sha256 = (text: string): Uint8Array => createHash('sha256').update(text).digest();

// ─── notification.dispatch ────────────────────────────────────────────────────────────────────────────────────

/**
 * `notification.dispatch`: decide the message of one notification for one complete response and write it down. A job
 * transaction, so the delivery-log row, the disclosures row and the `email.send` job commit together or not at all.
 *
 * The envelope's resource is the form (like `submission.fanout`); the notification and the response are looked up under it,
 * in the org's tenant, so an id of another org or another form finds nothing and is acked. Things that are simply no longer
 * so (the notification was deleted or turned off, the response was deleted or is held) end the job quietly; a notification
 * whose people cannot be found (an autoresponder whose respondent gave no address) sends nothing and says so in the log.
 */
function notificationDispatch(deps: EffectDeps) {
  return defineJob({
    name: 'notification.dispatch',
    perms: [],
    async run({ tx, orgId, log, job }) {
      const { resource, data } = job.envelope;
      const row = await readNotification(tx, resource.id, data.notificationId);
      if (!row || !row.enabled) {
        log.info({ notificationId: data.notificationId }, 'notification.dispatch: the notification is gone or turned off; nothing to send');
        return;
      }
      const loaded = await loadSubmission(tx, { formId: resource.id, submissionId: data.submissionId });
      if (!loaded) {
        log.info({ submissionId: data.submissionId }, 'notification.dispatch: no such response; nothing to send');
        return;
      }
      if (loaded.row.status !== 'complete') {
        log.info({ submissionId: loaded.row.id, status: loaded.row.status }, 'notification.dispatch: the response is not complete; nothing to send');
        return;
      }
      // One message per response and notification: a fan-out delivered twice must not mail the respondent twice. The lock
      // makes two dispatches of the same pair take turns, so the second finds the first one's row. (Not for `edited`: each
      // edit of a response is a message of its own, and the job does not yet say which edit it is.)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`notification.dispatch:${loaded.row.id}:${row.id}`}, 0))`);
      if (row.trigger === 'submitted') {
        const [existing] = await tx
          .select({ id: emailMessages.id })
          .from(emailMessages)
          .where(and(eq(emailMessages.submissionId, loaded.row.id), eq(emailMessages.submissionReceivedAt, loaded.row.receivedAt), eq(emailMessages.notificationId, row.id)))
          .limit(1);
        if (existing) {
          log.info({ submissionId: loaded.row.id, notificationId: row.id }, 'notification.dispatch: this response already has its message; not sending another');
          return;
        }
      }

      const composed = await compose(deps, tx, orgId, row, loaded);
      if (!composed.config.enabled) {
        log.info({ notificationId: row.id }, 'notification.dispatch: the notification is turned off in its config; nothing to send');
        return;
      }
      const delivered = deliveredTo(composed.recipients);
      if (delivered.length === 0) {
        log.info({ submissionId: loaded.row.id, notificationId: row.id, skippedRecipients: composed.recipients.skipped }, 'notification.dispatch: nobody to send to');
        return;
      }

      const masked = delivered.map((a) => maskAddress(a.address));
      const id = randomUUID();
      await tx.insert(emailMessages).values({
        id,
        orgId,
        formId: loaded.row.formId,
        submissionId: loaded.row.id,
        submissionReceivedAt: loaded.row.receivedAt,
        notificationId: row.id,
        role: row.kind,
        toDisplayMasked: masked,
        subjectHash: sha256(composed.rendered.subject),
        messageId: `<${id}@${deps.config.messageIdDomain}>`,
        status: 'queued',
      });
      await recordDisclosure(tx, {
        orgId,
        submissionId: loaded.row.id,
        submissionReceivedAt: loaded.row.receivedAt,
        recipient: { kind: 'notification', id: row.id },
        displayName: masked.join(', '),
        fieldKeys: disclosedFieldKeys(composed.fields),
      });
      await deps.queue.send('email.send', { orgId, resource: { type: 'email_message', id }, data: { emailMessageId: id } }, { tx: txExecutor(tx) });
      log.debug({ submissionId: loaded.row.id, notificationId: row.id, emailMessageId: id, recipients: delivered.length }, 'notification.dispatch: message queued');
    },
  });
}

// ─── email.send ───────────────────────────────────────────────────────────────────────────────────────────────

/** What the first unit of `email.send` found: nothing to do, a message that can no longer be sent, or the message to send. */
type Prepared =
  | { kind: 'skip'; why: string }
  | { kind: 'fail'; error: string }
  | { kind: 'send'; message: MailMessage; senderId: string | null };

const MAX_ERROR = 1000;

/** What the delivery log says when the egress guard refused the relay: never the guard's own text (see scrubError). */
export const MAIL_ADDRESS_REFUSED = 'the mail server address is not allowed (private, internal or not permitted)';
/** The guard could not resolve the relay's name: perhaps a DNS blip, so it is retried like an outage. */
export const MAIL_ADDRESS_UNRESOLVED = 'the mail server name did not resolve';

/**
 * The text a delivery log row may keep of an error: its code and message with every URL (an SMTP URL carries credentials)
 * and every address (an SMTP answer often repeats the recipient) replaced, cut to what the column holds.
 */
function scrubError(err: unknown): string {
  // The egress guard's text names the address the relay's host resolved to. On SaaS anyone may own an org and point a
  // sender at an internal name, and every member with submissions.read sees this row in the Email log: keeping the text
  // would tell them the private address of that name. A fixed sentence only; the guard's text goes to the worker log.
  if (isPortError(err, 'egress_denied')) return `egress_denied: ${err.cause !== undefined ? MAIL_ADDRESS_UNRESOLVED : MAIL_ADDRESS_REFUSED}`;
  const code = err instanceof PortError ? err.code : 'error';
  const message = err instanceof Error ? err.message : String(err);
  const scrubbed = replaceControls(
    message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').replace(/[^\s<>()"',;]+@[^\s<>()"',;]+/g, '[address]'),
  );
  return `${code}: ${scrubbed}`.slice(0, MAX_ERROR);
}

/** A failed send as an error the queue and the log may keep: the scrubbed text only, no cause chain that could hold a URL or an address. */
class EmailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailSendError';
  }
}

/** Only a server that was not reachable, or answered "try later", is worth another attempt; a refusal or a bad message is final. Anything unexpected is retried. */
const isTemporary = (err: unknown): boolean =>
  !(err instanceof PortError) || err.code === 'unavailable' || (err.code === 'egress_denied' && err.cause !== undefined);

/** `email.send` for one message: the first unit of work. Reads the log row, renders the message again and marks the row `sending`. */
async function prepareSend(deps: EffectDeps, tx: Tx, orgId: string, id: string): Promise<Prepared> {
  const [msg] = await tx
    .select({
      formId: emailMessages.formId,
      submissionId: emailMessages.submissionId,
      notificationId: emailMessages.notificationId,
      messageId: emailMessages.messageId,
      status: emailMessages.status,
    })
    .from(emailMessages)
    .where(eq(emailMessages.id, id))
    .limit(1);
  // Deleted with its response (the foreign key cascades): there is nothing left to send.
  if (!msg) return { kind: 'skip', why: 'the message is gone (its response was deleted)' };
  if (msg.status === 'sent' || msg.status === 'failed') return { kind: 'skip', why: `the message is already ${msg.status}` };
  const fail = (error: string): Prepared => ({ kind: 'fail', error });

  const row = await readNotification(tx, msg.formId, msg.notificationId);
  if (!row) return fail('The notification was deleted before this message was sent.');
  if (!row.enabled) return fail('The notification was turned off before this message was sent.');
  const loaded = await loadSubmission(tx, { formId: msg.formId, submissionId: msg.submissionId });
  if (!loaded) return fail('The response was deleted before this message was sent.');
  if (loaded.row.status === 'trashed' || loaded.row.status === 'spam') return fail(`The response was moved to ${loaded.row.status} before this message was sent.`);

  let composed: Composed;
  try {
    composed = await compose(deps, tx, orgId, row, loaded);
  } catch (err) {
    // A config that cannot be read is final for this message; the dispatch of a later response will show the same error.
    return fail(scrubError(err));
  }
  if (!composed.config.enabled) return fail('The notification was turned off before this message was sent.');
  const delivered = deliveredTo(composed.recipients);
  if (delivered.length === 0) return fail('The notification has no recipient who can be mailed now.');

  // The sender: the org's own mailbox (the foreign key keeps it the org's) or the platform's.
  let from = deps.config.mailFrom;
  let senderSecretRef: string | undefined;
  if (row.senderId !== null) {
    const [sender] = await tx
      .select({ fromAddress: emailSenders.fromAddress, fromName: emailSenders.fromName, smtpSecretId: emailSenders.smtpSecretId })
      .from(emailSenders)
      .where(eq(emailSenders.id, row.senderId))
      .limit(1);
    if (!sender) return fail('The notification’s email sender no longer exists.');
    from = { address: sender.fromAddress, ...(sender.fromName ? { name: sender.fromName } : {}) };
    senderSecretRef = sender.smtpSecretId;
  }
  if (composed.fromName !== '') from = { address: from.address, name: composed.fromName };

  // The ledger names what the dispatch could disclose; a notification edited since may now disclose more, and that is recorded before it is sent.
  const keys = disclosedFieldKeys(composed.fields);
  const recorded = await tx
    .select({ fieldKeys: disclosures.fieldKeys })
    .from(disclosures)
    .where(
      and(
        eq(disclosures.submissionId, loaded.row.id),
        eq(disclosures.submissionReceivedAt, loaded.row.receivedAt),
        eq(disclosures.recipientKind, 'notification'),
        eq(disclosures.recipientId, row.id),
      ),
    );
  const known = new Set(recorded.flatMap((r) => r.fieldKeys));
  const masked = delivered.map((a) => maskAddress(a.address));
  const missing = keys.filter((k) => !known.has(k));
  if (missing.length > 0) {
    await recordDisclosure(tx, {
      orgId,
      submissionId: loaded.row.id,
      submissionReceivedAt: loaded.row.receivedAt,
      recipient: { kind: 'notification', id: row.id },
      displayName: masked.join(', '),
      fieldKeys: missing,
    });
  }

  await tx
    .update(emailMessages)
    .set({ status: 'sending', subjectHash: sha256(composed.rendered.subject), toDisplayMasked: masked })
    .where(eq(emailMessages.id, id));

  const { to, cc, bcc, replyTo } = composed.recipients;
  const message: MailMessage = {
    from,
    to,
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    ...(replyTo ? { replyTo } : {}),
    subject: composed.rendered.subject,
    text: composed.rendered.text,
    html: composed.rendered.html,
    messageId: msg.messageId,
    ...(senderSecretRef ? { senderSecretRef } : {}),
  };
  return { kind: 'send', message, senderId: row.senderId };
}

/**
 * `email.send` (`transaction: 'manual'`): send one logged message. Three units: read and render (a transaction), the SMTP
 * call (no connection held), record the result (a transaction). The rules:
 *   - a `sent` or `failed` row is left alone, so a job delivered twice sends once;
 *   - the message is rendered again from the notification and the response as they are now, with the Message-ID of the row;
 *   - sent: `sent`, the provider's id and the time; the error of an earlier try is cleared;
 *   - the server unreachable or "try later" (a PortError `unavailable`, a temporary refusal): one more attempt counted, the
 *     scrubbed error kept, `retrying`, and the job throws so the queue tries again with its back-off; on the last attempt of the
 *     queue's policy the row is `failed` instead (the job still throws, so the dead-letter queue shows it);
 *   - a refusal for good (`rejected`, `invalid_argument`, a missing or foreign sender secret, an egress denial): `failed`, no retry.
 * A crash between the SMTP answer and the record sends the message again on the retry, with the same Message-ID.
 */
function emailSend(deps: EffectDeps) {
  return defineJob({
    name: 'email.send',
    transaction: 'manual',
    perms: [],
    async run(ctx) {
      // `email.send` is a queue of the whole platform (auth emails run without an org); this work package serves a notification's message, which always has one.
      if (ctx.kind !== 'org') throw new Error('email.send without an org is not served yet (auth emails move onto this queue with BL-201)');
      const { orgId, log, job, inTenant } = ctx;
      const id = job.envelope.data.emailMessageId;
      if (!isUuid(id)) {
        log.warn('email.send: the message id is not a uuid; nothing to send');
        return;
      }

      const prepared = await inTenant((tx) => prepareSend(deps, tx, orgId, id));
      if (prepared.kind === 'skip') {
        log.info({ emailMessageId: id }, `email.send: ${prepared.why}`);
        return;
      }
      if (prepared.kind === 'fail') {
        await inTenant((tx) => tx.update(emailMessages).set({ status: 'failed', lastError: prepared.error.slice(0, MAX_ERROR) }).where(eq(emailMessages.id, id)));
        log.warn({ emailMessageId: id }, 'email.send: the message can no longer be sent');
        return;
      }

      // By id alone: the key is (id, created_at), but `created_at` has microseconds and a JS Date has milliseconds, so it cannot be matched back.
      const where = eq(emailMessages.id, id);
      let failure: unknown;
      let sent: Awaited<ReturnType<ReturnType<EffectDeps['mailerFor']>['send']>> | undefined;
      try {
        sent = await deps.mailerFor(orgId, prepared.senderId).send(prepared.message);
      } catch (err) {
        failure = err;
      }

      const result = sent;
      if (result) {
        const refused = result.refused.length;
        await inTenant((tx) =>
          tx
            .update(emailMessages)
            .set({
              status: 'sent',
              attempts: sql`${emailMessages.attempts} + 1`,
              providerMessageId: result.messageId.slice(0, 255),
              sentAt: deps.now(),
              lastError: refused > 0 ? `${refused} recipient${refused === 1 ? ' was' : 's were'} refused by the mail server` : null,
            })
            .where(where),
        );
        log.info({ emailMessageId: id, attempt: job.attempt, refused }, 'email.send: sent');
        return;
      }

      const error = scrubError(failure);
      if (isPortError(failure, 'egress_denied')) log.warn({ emailMessageId: id, guard: failure.message }, 'email.send: the egress guard refused the relay');
      if (!isTemporary(failure)) {
        await inTenant((tx) => tx.update(emailMessages).set({ status: 'failed', attempts: sql`${emailMessages.attempts} + 1`, lastError: error }).where(where));
        log.warn({ emailMessageId: id, attempt: job.attempt, error }, 'email.send: refused for good; not retrying');
        return;
      }
      const lastAttempt = job.attempt >= JOB_POLICIES['email.send'].retryLimit + 1;
      await inTenant((tx) =>
        tx
          .update(emailMessages)
          .set({ status: lastAttempt ? 'failed' : 'retrying', attempts: sql`${emailMessages.attempts} + 1`, lastError: error })
          .where(where),
      );
      log.warn({ emailMessageId: id, attempt: job.attempt, lastAttempt, error }, 'email.send: could not send');
      throw new EmailSendError(error);
    },
  });
}

