import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import nodemailer from 'nodemailer';
import { PortError, type MailAddress, type MailMessage, type MailRefusal, type Mailer } from '@form/ports';
import { hasControlChars } from '../text.ts';

export interface SmtpMailerOptions {
  /** `smtp://host:port` (plain, as Mailpit listens) or `smtps://user:pass@host:465`. Default: Mailpit on localhost. */
  url?: string;
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
}

const isPermanent = (e: SmtpError) => e.responseCode !== undefined && e.responseCode >= 500 && e.responseCode < 600;

/**
 * A 5xx to RCPT TO or DATA refuses this message for good. A 5xx elsewhere (MAIL FROM, AUTH) is a sender or
 * configuration problem, not the recipient's, so it stays 'unavailable' and never leads to a suppression.
 */
function deliveryError(e: unknown): PortError {
  const err = e as SmtpError;
  const code = isPermanent(err) && (err.command === 'RCPT TO' || err.command === 'DATA') ? 'rejected' : 'unavailable';
  return new PortError(code, `SMTP delivery failed: ${err.message}`, { cause: e });
}

/**
 * SMTP mailer for dev and tests; defaults to Mailpit (`axllent/mailpit`, SMTP on 1025, UI on 8025).
 * Per-org senders arrive with the production SMTP adapter (WP-1.03).
 */
export function createSmtpMailer(o: SmtpMailerOptions = {}): Mailer {
  const timeout = o.timeoutMs ?? 10_000;
  const messageIdDomain = o.messageIdDomain === undefined ? undefined : idDomain(o.messageIdDomain);
  const transport = nodemailer.createTransport({
    url: o.url ?? MAILPIT_SMTP_URL,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
  });

  return {
    async send(m) {
      checkMessage(m);
      const messageId = m.messageId ?? `<${randomUUID()}@${messageIdDomain ?? idDomain(m.from.address.slice(m.from.address.lastIndexOf('@') + 1))}>`;
      let info: { rejectedErrors?: SmtpError[] | undefined };
      try {
        info = await transport.sendMail({
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
      }
      const refused = (info.rejectedErrors ?? []).map(
        (e): MailRefusal => ({ address: e.recipient ?? '', permanent: isPermanent(e), response: e.response ?? e.message }),
      );
      return { messageId, refused };
    },

    async verify(senderSecretRef) {
      if (senderSecretRef !== undefined) return { ok: false, error: 'per-org senders are not supported by the dev SMTP mailer' };
      try {
        await transport.verify();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  };
}
