import type { FastifyBaseLogger } from 'fastify';
import type { MailAddress, Mailer } from '@form/ports';

export type LinkMailKind = 'verify_email' | 'magic_link' | 'password_reset' | 'account_exists';
type TokenLinkKind = Exclude<LinkMailKind, 'account_exists'>;

export const LINK_MINUTES: Record<TokenLinkKind, number> = {
  verify_email: 24 * 60,
  magic_link: 15,
  password_reset: 60,
};

/** Builder pages that read the token from the fragment, so it never reaches a server log or a Referer. */
export const LINK_PATHS: Record<TokenLinkKind | 'invite', string> = {
  verify_email: '/auth/verify',
  magic_link: '/auth/magic',
  password_reset: '/auth/reset',
  invite: '/invite',
};

/** Account and privacy messages (CMP-21): the deletion confirmation, and a grievance's receipt and its copy for the privacy contact. */
export type AccountMail =
  | { kind: 'account_deleted'; to: MailAddress; backupsExpireBy: string; contactEmail: string }
  | { kind: 'grievance_received'; to: MailAddress; reference: string; dueBy: string; contactEmail: string }
  | { kind: 'grievance_filed'; to: MailAddress; reference: string; category: string; dueBy: string; from: string; message: string };

export type AuthMail =
  | {
      kind: LinkMailKind;
      to: MailAddress;
      /** Builder URL the message links to, the token in its fragment. */
      link: string;
    }
  | {
      kind: 'invite';
      to: MailAddress;
      link: string;
      /** Who invites to which org, with which role, for how many days. */
      invite: { orgName: string; inviterName: string; role: string; days: number };
    }
  | AccountMail;

export type AuthMailKind = AuthMail['kind'];

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
    case 'invite': {
      const i = m.invite;
      return {
        subject: `${i.inviterName} invited you to ${i.orgName} on fORM-`,
        text: `${i.inviterName} invited you to join ${i.orgName} on fORM- as ${/^[ao]/.test(i.role) ? 'an' : 'a'} ${i.role}. Accept here:\n\n${m.link}\n\nSign in or create an account with this email address to accept. The invitation expires in ${i.days} ${i.days === 1 ? 'day' : 'days'}. If you did not expect it, ignore this message.\n`,
      };
    }
    case 'account_exists':
      return {
        subject: 'You already have an account',
        text: `Someone tried to create a fORM- account with this address, which already has one. Sign in here:\n\n${m.link}\n\nForgot your password? Use "Forgot password" on that page. If this was not you, no action is needed.\n`,
      };
    case 'account_deleted':
      return {
        subject: 'Your account was deleted',
        text: `Your fORM- account was deleted: you were signed out everywhere and removed from your organisations. Forms you owned stay with their organisations.\n\nCopies in our backups expire by ${m.backupsExpireBy}. Security records are kept as the privacy notice describes and no longer name you.\n\nIf you did not do this, write to ${m.contactEmail} at once.\n`,
      };
    case 'grievance_received':
      return {
        subject: `We received your request ${m.reference}`,
        text: `We received your privacy request. Its reference is ${m.reference}; we answer by ${m.dueBy}, sooner when we can.\n\nTo add anything, write to ${m.contactEmail} and quote the reference.\n`,
      };
    case 'grievance_filed':
      return {
        subject: `Privacy request ${m.reference} (${m.category})`,
        text: `A builder user sent a privacy request.\n\nReference: ${m.reference}\nCategory: ${m.category}\nFrom: ${m.from}\nAnswer by: ${m.dueBy}\n\n${m.message}\n`,
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
