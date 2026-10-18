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

/**
 * Invalid messages (no recipient, CR/LF in a header, malformed address) → PortError('invalid_argument').
 * The server permanently refusing every recipient or the message itself → PortError('rejected'), so `email.send`
 * can suppress instead of retrying; outages, auth failures and temporary (4xx) refusals → PortError('unavailable').
 */
export interface Mailer {
  send(m: MailMessage): Promise<MailSent>;
  verify(senderSecretRef?: string): Promise<{ ok: boolean; error?: string }>;
}
