import { PortError } from './common.ts';

export interface MailAddress {
  address: string;
  name?: string;
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface MailMessage {
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  replyTo?: MailAddress;
  subject: string;
  text: string;
  html?: string;
  /**
   * Stable `<id@domain>` set by the caller for at-least-once delivery, so a resend after a crash
   * carries the same Message-ID and clients de-duplicate (architecture §5.1, F-49).
   */
  messageId?: string;
  /** Extra headers (`List-Unsubscribe`, …). Names and values must not contain CR or LF. */
  headers?: Record<string, string>;
  attachments?: MailAttachment[];
  /** The org's own SMTP sender (`email_senders.smtp_secret_id`); without it the platform sender delivers. */
  senderSecretRef?: string;
}

/** A recipient the server refused while it accepted the message for others. */
export interface MailRefusal {
  address: string;
  /** 5xx: a hard bounce (suppress); otherwise deferred (retry for this address). */
  permanent: boolean;
  response: string;
}

export interface MailSent {
  messageId: string;
  /** Empty when every recipient was accepted. */
  refused: MailRefusal[];
}

/** Which part of a delivery the server refused: some or all recipients, or the message after DATA. */
export type MailRefusalScope = 'recipients' | 'message';

/**
 * A refusal the server answered to RCPT TO or DATA. `refused` lists every recipient it refused, so a caller
 * can suppress the hard bounces even when the error is 'unavailable' because another recipient was deferred.
 */
export class MailDeliveryError extends PortError {
  readonly scope: MailRefusalScope;
  readonly refused: readonly MailRefusal[];

  constructor(code: 'rejected' | 'unavailable', scope: MailRefusalScope, refused: readonly MailRefusal[], message: string, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = 'MailDeliveryError';
    this.scope = scope;
    this.refused = refused;
  }
}

/**
 * Invalid messages (no recipient, CR/LF in a header, malformed address) → PortError('invalid_argument').
 * The server permanently refusing every recipient or the message itself → PortError('rejected'), so `email.send`
 * can suppress instead of retrying; outages, auth failures and temporary (4xx) refusals → PortError('unavailable').
 * Refusals of recipients or of the message are a MailDeliveryError (either code) that says which.
 * An unknown `senderSecretRef` → PortError('not_found').
 */
export interface Mailer {
  send(m: MailMessage): Promise<MailSent>;
  verify(senderSecretRef?: string): Promise<{ ok: boolean; error?: string }>;
}
