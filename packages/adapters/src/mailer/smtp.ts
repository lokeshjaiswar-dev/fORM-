import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import nodemailer from 'nodemailer';
import { MailDeliveryError, PortError, type EgressGuard, type MailAddress, type MailMessage, type MailRefusal, type Mailer } from '@form/ports';
import { hasControlChars } from '../text.ts';

/** Per-org SMTP senders (`email_senders.smtp_secret_id`): the secret behind a ref is an SMTP URL with credentials. */
export interface SmtpSenders {
  /** The SMTP URL of a ref, or undefined when there is no such sender. */
  resolve(senderSecretRef: string): Promise<string | undefined>;
  /** Org-supplied relays are tenant destinations: they always pass the EGRESS_POLICY guard (SSRF). */
  egress: EgressGuard;
}

export interface SmtpMailerOptions {
  /**
   * The platform relay: `smtp://host:port` (STARTTLS when offered; required when the URL has credentials) or
   * `smtps://user:pass@host:465`. Default: Mailpit on localhost.
   */
  url?: string;
  /**
   * Holds the platform relay to EGRESS_POLICY and pins the connection to the address it vetted. The relay is
   * operator configuration, so the composition root passes the guard with the relay as a trusted endpoint.
   */
  egress?: EgressGuard;
  senders?: SmtpSenders;
  /** Domain of generated Message-IDs; default: the sender's domain. */
  messageIdDomain?: string;
  /** Socket timeouts in milliseconds. */
  timeoutMs?: number;
}

export const MAILPIT_SMTP_URL = 'smtp://localhost:1025';

const LOCAL = /^[^\s@<>()[\]\\,;:"]+$/u;
const DOMAIN = /^(?:[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?$/u;
const HEADER_NAME = /^[!-9;-~]+$/;
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const DOT_ATOM = `${ATOM}(?:\\.${ATOM})*`;
/** RFC 5322 msg-id, dot-atom-text on both sides (ASCII only). */
const MESSAGE_ID = new RegExp(`^<${DOT_ATOM}@${DOT_ATOM}>$`);
const ID_DOMAIN = new RegExp(`^${DOT_ATOM}$`);
/** Headers the mailer owns; a caller setting them could add recipients or forge the sender. */
const RESERVED_HEADERS = new Set(['from', 'to', 'cc', 'bcc', 'reply-to', 'sender', 'subject', 'message-id', 'date', 'mime-version', 'content-type', 'content-transfer-encoding', 'return-path']);

const invalid = (message: string) => new PortError('invalid_argument', message);

function checkAddress(a: MailAddress, field: string): void {
  const at = a.address.lastIndexOf('@');
  if (at < 1 || hasControlChars(a.address) || !LOCAL.test(a.address.slice(0, at)) || !DOMAIN.test(a.address.slice(at + 1))) {
    throw invalid(`${field}: invalid address ${JSON.stringify(a.address)}`);
  }
  if (a.name !== undefined && hasControlChars(a.name)) throw invalid(`${field}: control characters in display name`);
}

function checkMessage(m: MailMessage): void {
  checkAddress(m.from, 'from');
  if (m.replyTo) checkAddress(m.replyTo, 'replyTo');
  const recipients = [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])];
  if (recipients.length === 0) throw invalid('the message has no recipients');
  for (const r of recipients) checkAddress(r, 'recipient');
  if (hasControlChars(m.subject)) throw invalid('control characters in subject');
  if (m.messageId !== undefined && !MESSAGE_ID.test(m.messageId)) throw invalid('messageId must be <dot-atom@dot-atom> in ASCII');
  for (const [name, value] of Object.entries(m.headers ?? {})) {
    if (!HEADER_NAME.test(name)) throw invalid(`invalid header name ${JSON.stringify(name)}`);
    if (RESERVED_HEADERS.has(name.toLowerCase())) throw invalid(`header ${name} is set by the mailer`);
    if (hasControlChars(value, { allowTab: true })) throw invalid(`control characters in header ${name}`);
  }
  for (const a of m.attachments ?? []) {
    if (a.filename.length === 0 || hasControlChars(a.filename) || hasControlChars(a.contentType)) throw invalid('invalid attachment');
  }
}

/** Message-ID domains are ASCII; an IDN becomes punycode. */
function idDomain(domain: string): string {
  const ascii = domainToASCII(domain);
  if (!ID_DOMAIN.test(ascii)) throw invalid(`invalid Message-ID domain ${JSON.stringify(domain)}`);
  return ascii;
}

/** The fields of nodemailer's errors this adapter reads. */
interface SmtpError {
  message: string;
  responseCode?: number | undefined;
  command?: string | undefined;
  response?: string | undefined;
  recipient?: string | undefined;
  rejectedErrors?: SmtpError[] | undefined;
}

const isPermanent = (e: SmtpError) => e.responseCode !== undefined && e.responseCode >= 500 && e.responseCode < 600;
const refusal = (e: SmtpError): MailRefusal => ({ address: e.recipient ?? '', permanent: isPermanent(e), response: e.response ?? e.message });

/**
 * RCPT TO refusals of every recipient: 'rejected' only when each one is permanent (a deferred recipient may still
 * be delivered on retry), in whatever order the server answered. A 5xx to DATA refuses the message for good. A 5xx
 * anywhere else (MAIL FROM, AUTH) is a sender or configuration problem, not the recipient's, so it stays
 * 'unavailable' and never leads to a suppression.
 */
function deliveryError(e: unknown): PortError {
  const err = e as SmtpError;
  if (err.rejectedErrors?.length || err.command === 'RCPT TO') {
    const refused = (err.rejectedErrors?.length ? err.rejectedErrors : [err]).map(refusal);
    const code = refused.every((r) => r.permanent) ? 'rejected' : 'unavailable';
    return new MailDeliveryError(code, 'recipients', refused, `SMTP delivery failed: ${err.message}`, { cause: e });
  }
  if (err.command === 'DATA') return new MailDeliveryError(isPermanent(err) ? 'rejected' : 'unavailable', 'message', [], `SMTP delivery failed: ${err.message}`, { cause: e });
  return new PortError('unavailable', `SMTP delivery failed: ${err.message}`, { cause: e });
}

/**
 * Transport options of an SMTP URL; with a pinned address the socket goes there while TLS still checks the name.
 * A URL with credentials over `smtp://` requires STARTTLS, so AUTH never goes out in plaintext when the server (or
 * someone in the path) does not offer it.
 */
function transportOptions(url: string, timeout: number, pinnedIp?: string) {
  const u = new URL(url);
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') throw new PortError('invalid_argument', `expected an smtp:// or smtps:// URL, got ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const secure = u.protocol === 'smtps:';
  return {
    host: pinnedIp ?? host,
    port: Number(u.port || (secure ? 465 : 25)),
    secure,
    requireTLS: !secure && u.username !== '',
    ...(u.username ? { auth: { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } } : {}),
    tls: { servername: host },
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
  };
}

/**
 * SMTP mailer (architecture §6): the platform relay (an India-hosted provider on SaaS, the customer relay on-prem,
 * Mailpit in development) and per-org senders. Recipient refusals come back per address, so `email.send` can
 * suppress hard bounces and retry deferrals.
 */
export function createSmtpMailer(o: SmtpMailerOptions = {}): Mailer {
  const timeout = o.timeoutMs ?? 10_000;
  const messageIdDomain = o.messageIdDomain === undefined ? undefined : idDomain(o.messageIdDomain);
  const platformUrl = o.url ?? MAILPIT_SMTP_URL;
  transportOptions(platformUrl, timeout);

  async function transport(senderSecretRef: string | undefined) {
    let url = platformUrl;
    let guard = o.egress;
    if (senderSecretRef !== undefined) {
      const resolved = o.senders ? await o.senders.resolve(senderSecretRef) : undefined;
      if (resolved === undefined) throw new PortError('not_found', 'no such SMTP sender');
      url = resolved;
      guard = o.senders!.egress;
    }
    const pinned = guard ? (await guard.assertAllowed(new URL(url))).pinnedIp : undefined;
    return nodemailer.createTransport(transportOptions(url, timeout, pinned));
  }

  return {
    async send(m) {
      checkMessage(m);
      const messageId = m.messageId ?? `<${randomUUID()}@${messageIdDomain ?? idDomain(m.from.address.slice(m.from.address.lastIndexOf('@') + 1))}>`;
      const t = await transport(m.senderSecretRef);
      let info: { rejectedErrors?: SmtpError[] | undefined };
      try {
        info = await t.sendMail({
          messageId,
          from: m.from,
          to: m.to,
          ...(m.cc ? { cc: m.cc } : {}),
          ...(m.bcc ? { bcc: m.bcc } : {}),
          ...(m.replyTo ? { replyTo: m.replyTo } : {}),
          subject: m.subject,
          text: m.text,
          ...(m.html !== undefined ? { html: m.html } : {}),
          ...(m.headers ? { headers: m.headers } : {}),
          ...(m.attachments
            ? { attachments: m.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content) })) }
            : {}),
        });
      } catch (e) {
        throw deliveryError(e);
      } finally {
        t.close();
      }
      return { messageId, refused: (info.rejectedErrors ?? []).map(refusal) };
    },

    async verify(senderSecretRef) {
      let t;
      try {
        t = await transport(senderSecretRef);
        await t.verify();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      } finally {
        t?.close();
      }
    },
  };
}
