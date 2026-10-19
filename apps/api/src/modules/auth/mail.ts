import type { FastifyBaseLogger } from 'fastify';
import type { MailAddress, Mailer } from '@form/ports';

export type AuthMailKind = 'verify_email' | 'magic_link' | 'password_reset' | 'account_exists';

export const LINK_MINUTES: Record<Exclude<AuthMailKind, 'account_exists'>, number> = {
  verify_email: 24 * 60,
  magic_link: 15,
  password_reset: 60,
};

/** Builder pages that read the token from the fragment, so it never reaches a server log or a Referer. */
export const LINK_PATHS: Record<Exclude<AuthMailKind, 'account_exists'>, string> = {
  verify_email: '/auth/verify',
  magic_link: '/auth/magic',
  password_reset: '/auth/reset',
};

export interface AuthMail {
  kind: AuthMailKind;
  to: MailAddress;
  /** Builder URL the message links to, the token in its fragment. */
  link: string;
}

function body(m: AuthMail): { subject: string; text: string } {
  switch (m.kind) {
    case 'verify_email':
      return {
        subject: 'Confirm your email address',
        text: `Confirm your email address to finish creating your fORM- account:\n\n${m.link}\n\nThe link works once and expires in 24 hours. If you did not sign up, ignore this message.\n`,
      };
    case 'magic_link':
      return {
        subject: 'Your sign-in link',
        text: `Use this link to sign in to fORM-:\n\n${m.link}\n\nThe link works once and expires in 15 minutes. If you did not ask for it, ignore this message.\n`,
      };
    case 'password_reset':
      return {
        subject: 'Reset your password',
        text: `Use this link to choose a new fORM- password:\n\n${m.link}\n\nThe link works once and expires in 1 hour. Resetting signs you out everywhere. If you did not ask for it, ignore this message.\n`,
      };
    case 'account_exists':
      return {
        subject: 'You already have an account',
        text: `Someone tried to create a fORM- account with this address, which already has one. Sign in here:\n\n${m.link}\n\nForgot your password? Use "Forgot password" on that page. If this was not you, no action is needed.\n`,
      };
  }
}

/**
 * Auth emails through the Mailer port (WP-0.15: the dev SMTP adapter and Mailpit; production SMTP is WP-1.03).
 * Callers send once the transaction that issued the link has committed (a rollback mails nothing), and the send runs
 * in the background, so the time to answer does not reveal whether an address has an account.
 * Failures are logged, never thrown to the caller; `idle()` waits for the sends in flight (shutdown, tests).
 */
export function createAuthMailer(o: { mailer: Mailer; from: MailAddress; log: FastifyBaseLogger }) {
  const inFlight = new Set<Promise<void>>();
  return {
    send(m: AuthMail): void {
      const { subject, text } = body(m);
      const p = o.mailer
        .send({ from: o.from, to: [m.to], subject, text, headers: { 'Auto-Submitted': 'auto-generated' } })
        .then(
          (sent) => {
            if (sent.refused.length > 0) o.log.warn({ kind: m.kind, refused: sent.refused.length }, 'auth email refused');
          },
          (err: unknown) => o.log.error({ err, kind: m.kind }, 'auth email was not sent'),
        )
        .finally(() => inFlight.delete(p));
      inFlight.add(p);
    },
    async idle(): Promise<void> {
      await Promise.all([...inFlight]);
    },
  };
}

export type AuthMailer = ReturnType<typeof createAuthMailer>;

/** `MAILER_DRIVER=log`: the recipient count and subject reach the log, never the address or the link. */
export function createLogMailer(log: FastifyBaseLogger): Mailer {
  let n = 0;
  return {
    async send(m) {
      n += 1;
      log.info({ subject: m.subject, recipients: m.to.length }, 'mail (log driver): not delivered');
      return { messageId: `<log-${n}@form.local>`, refused: [] };
    },
    async verify() {
      return { ok: true };
    },
  };
}
