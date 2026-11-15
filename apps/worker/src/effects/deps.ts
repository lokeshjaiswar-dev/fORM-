import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { emailSenders, isUuid, secretEnc, secretPublicColumns, secrets, withTenant, type Db } from '@form/db';
import { PortError, type EgressGuard, type MailAddress, type Mailer, type OrgSecrets, type Queue, type Storage } from '@form/ports';
import type { Logger } from 'pino';

/*
 * What the effect jobs (notifications WP-1.16, exports WP-1.17, webhooks WP-1.18) are given, in one object built by the
 * composition root (`main.ts`). This file imports no adapter: everything that needs one (the SMTP mailer, the egress guard,
 * the KMS behind `OrgSecrets`) arrives built, as a port or as a factory parameter, so the jobs and their tests need only fakes.
 */

/** Settings every effect job reads; the rest of the worker's config stays in `main.ts`. */
export interface EffectConfig {
  /** The builder's origin without a trailing slash: the "view response" button of an email links to it. */
  publicBuilderUrl: string;
  /** The platform sender (`MAIL_FROM`): the `from` of a message that names no org sender. */
  mailFrom: MailAddress;
  /** The domain of the Message-IDs the worker makes (`<id@domain>`). */
  messageIdDomain: string;
  /** The `User-Agent` of a webhook delivery. */
  webhookUserAgent: string;
}

export interface EffectDeps {
  db: Db;
  /** The queue producer: a consumer or a job enqueues its children through it, with `tx: txExecutor(tx)` so they commit with the work. */
  queue: Queue;
  /** Seals and opens the org's secrets (SMTP credentials, webhook signing keys), built by `createOrgSecrets(keys)`. */
  orgSecrets: OrgSecrets;
  /** The object store; absent when no `STORAGE_*` is configured (an export then fails with a clear error). */
  storage?: Storage | undefined;
  /**
   * The mailer for one message. With no `senderId` the platform mailer sends it (`MAILER_DRIVER`, `SMTP_URL`); with the id of
   * one of the org's email senders it goes through that sender's SMTP server, whose credentials are opened here for this
   * org only. Nothing is read until `send` or `verify`, so call it where the message is sent, outside any transaction.
   * The message's `senderSecretRef` may be left out for an org sender (it is the sender's own); one that is set must name an
   * SMTP secret of the same org.
   */
  mailerFor(orgId: string, senderId?: string | null): Mailer;
  /** SSRF and air-gap guard for destinations a tenant chose (webhook URLs, org SMTP servers): `EGRESS_POLICY` and its allowlist, no trusted hosts. */
  tenantEgress: EgressGuard;
  config: EffectConfig;
  now(): Date;
}

/** What an `OrgMailerFactory` calls to read an org's SMTP URL by the secret's id; undefined for a secret that is not the org's or not an SMTP one. */
export interface SmtpSecretReader {
  resolve(ref: string): Promise<string | undefined>;
}

/** Makes the SMTP mailer that sends through the org's own servers (`createSmtpMailer` with `senders`), given in `main.ts` so this file imports no adapter. */
export type OrgMailerFactory = (senders: SmtpSecretReader) => Mailer;

/**
 * The SMTP URL of an org's secret: read as a system job of that org (`secrets` is RLS-scoped to the org, and `secret_enc`
 * answers only inside the org's own context), then opened with the org's key context. The transaction ends before the KMS is
 * called. A ref that is not a uuid, not in this org, or not of kind smtp gives undefined; nothing is logged or put in an error.
 */
async function smtpUrlOf(o: { db: Db; orgSecrets: OrgSecrets }, orgId: string, ref: string): Promise<string | undefined> {
  if (!isUuid(ref)) return undefined;
  const enc = await withTenant(o.db, { orgId, actor: 'system', requestId: `smtp-secret:${orgId}`, perms: [], readOnly: true }, async (tx) => {
    const [row] = await tx.select(secretPublicColumns).from(secrets).where(eq(secrets.id, ref)).limit(1);
    return row?.kind === 'smtp' ? secretEnc(tx, ref) : null;
  });
  if (!enc) return undefined;
  return new TextDecoder().decode(await o.orgSecrets.open({ orgId, secretId: ref, kind: 'smtp' }, enc));
}

/** The smtp secret behind one of the org's senders, or a `not_found` when the org has no such sender. */
async function senderSecretOf(db: Db, orgId: string, senderId: string): Promise<string> {
  if (!isUuid(senderId)) throw new PortError('not_found', 'no such email sender');
  const [row] = await withTenant(db, { orgId, actor: 'system', requestId: `email-sender:${orgId}`, perms: [], readOnly: true }, (tx) =>
    tx.select({ secretId: emailSenders.smtpSecretId }).from(emailSenders).where(eq(emailSenders.id, senderId)).limit(1),
  );
  if (!row) throw new PortError('not_found', 'no such email sender');
  return row.secretId;
}

export interface MailerForOptions {
  db: Db;
  orgSecrets: OrgSecrets;
  /** Sends the messages that name no org sender. */
  platform: Mailer;
  makeOrgMailer: OrgMailerFactory;
}

/** `EffectDeps.mailerFor` over the platform mailer and the org's SMTP senders. */
export function createMailerFor(o: MailerForOptions): EffectDeps['mailerFor'] {
  return (orgId, senderId) => {
    if (senderId === undefined || senderId === null) return o.platform;
    const org = o.makeOrgMailer({ resolve: (ref) => smtpUrlOf(o, orgId, ref) });
    return {
      async send(m) {
        return org.send({ ...m, senderSecretRef: m.senderSecretRef ?? (await senderSecretOf(o.db, orgId, senderId)) });
      },
      async verify(ref) {
        return org.verify(ref ?? (await senderSecretOf(o.db, orgId, senderId)));
      },
    };
  };
}

/**
 * `MAILER_DRIVER=log`: sends nothing and says so. The log names the message id and how many recipients it had, never an
 * address, a subject or a body: a notification carries a respondent's answers.
 */
export function createLogMailer(log: Logger): Mailer {
  return {
    async send(m) {
      const messageId = m.messageId ?? `<${randomUUID()}@log.invalid>`;
      log.info({ messageId, recipients: m.to.length + (m.cc?.length ?? 0) + (m.bcc?.length ?? 0) }, 'MAILER_DRIVER=log: message not sent');
      return { messageId, refused: [] };
    },
    async verify() {
      return { ok: true };
    },
  };
}

/**
 * The `OrgSecrets` of a worker that has no KMS key provider (development without `KMS_KEYFILE_PATH`): every call fails with
 * `unavailable`, which a job retries, instead of the worker pretending to open a secret.
 */
export const unavailableOrgSecrets: OrgSecrets = {
  async seal() {
    throw new PortError('unavailable', 'org secrets need a KMS: set KMS_KEYFILE_PATH or another KMS_DRIVER');
  },
  async open() {
    throw new PortError('unavailable', 'org secrets need a KMS: set KMS_KEYFILE_PATH or another KMS_DRIVER');
  },
};
