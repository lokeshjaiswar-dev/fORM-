import { createHash, randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { audit, PLATFORM_ORG_KEY, userNoticeAcks, type NoticeAckContext, type Tx } from '@form/db';
import type { PrivacyConfig } from '../../config.ts';
import { hex } from '../auth/crypto.ts';
import type { ClientInfo } from '../auth/sessions.ts';

/**
 * The platform's own privacy notice for builder users (CMP-21, DPDP s.5 and Rule 3): shown at sign-up and in the
 * account settings, its version and hash recorded per user. The wording is the one in
 * `docs/legal/platform-privacy-notice.md` (a test keeps them in step); any change gets a new version, and the builder
 * then asks every user to read the new text.
 */
export const NOTICE_VERSION = '2026-10-19';
export const NOTICE_LOCALE = 'en-IN';

export interface NoticeSectionTemplate {
  id: string;
  heading: string;
  paragraphs: readonly string[];
  items: readonly string[];
}

/** Placeholders: `{fiduciary}`, `{contact}`, `{email}`, `{version}`. */
export const NOTICE_TEMPLATE: { title: string; sections: readonly NoticeSectionTemplate[] } = {
  title: 'Privacy notice for fORM- accounts',
  sections: [
    {
      id: 'who',
      heading: 'Who is responsible',
      paragraphs: [
        '{fiduciary} runs this service and is the Data Fiduciary for the personal data of your account under the Digital Personal Data Protection Act, 2023.',
        'Forms and the responses they collect belong to the organisations that publish them. Each organisation is the Data Fiduciary for its forms and responses, and we process them only on its instructions. This notice is about your account, not about those responses.',
      ],
      items: [],
    },
    {
      id: 'data',
      heading: 'What we collect',
      paragraphs: ['We collect only what your account needs:'],
      items: [
        'Your name and email address, which you give us when you sign up, or which Google or Microsoft share with us when you sign in with them.',
        'Your password, kept only as a one-way hash, and, if you turn on two-factor sign-in, your authenticator key (encrypted) and your recovery codes (hashed).',
        'Sign-in and security records: your sessions, a short description of the browser you used, a keyed hash of your IP address that changes every day (never the address itself), and a log of sign-ins and account changes.',
        'The organisations you belong to and your role in each.',
        'The privacy requests and complaints you send us, and which version of this notice you were shown.',
      ],
    },
    {
      id: 'purposes',
      heading: 'Why we use it',
      paragraphs: [],
      items: [
        'To create and run your account, sign you in and let you work in your organisations.',
        'To keep your account and the service secure: limiting sign-in attempts, detecting abuse, investigating incidents, and keeping the security logs Indian law requires.',
        'To send you messages about your account: sign-in links, confirmations and security alerts. We do not send marketing from these records.',
        'To count how the service is used. Counts that combine several organisations are shown only when at least five different organisations contributed, and never name you or your organisation.',
      ],
    },
    {
      id: 'sharing',
      heading: 'Who sees it',
      paragraphs: [],
      items: [
        'The organisations you belong to see your name, email address and role.',
        'Providers that host and run this service for us, such as hosting and email delivery, process it only on our instructions.',
        'We do not sell your data, and we disclose it to authorities only when the law requires us to.',
      ],
    },
    {
      id: 'retention',
      heading: 'How long we keep it',
      paragraphs: [],
      items: [
        'Your account data stays until you delete your account.',
        'Sessions end after 14 days at most, and emailed links expire within a day.',
        'Security and audit records are kept for 13 months online, then archived for up to 7 years in a log that cannot be edited. Once your account is deleted, they refer only to an identifier that no longer names you.',
        'Deleted data leaves our backups as they expire, within 35 days.',
      ],
    },
    {
      id: 'rights',
      heading: 'Your choices and rights',
      paragraphs: [],
      items: [
        'See and download what we hold about you, at any time, from the Privacy page of your account.',
        'Correct your name, or ask us to correct anything else.',
        'Delete your account. This also withdraws your consent; it does not undo what was done before. If you are the last owner of an organisation, first make someone else an owner, or delete the organisation.',
        'Nominate someone to exercise these rights for you if you die or can no longer do so yourself.',
        'Forms and responses belong to your organisations: an owner or admin of the organisation manages them.',
      ],
    },
    {
      id: 'contact',
      heading: 'Questions and complaints',
      paragraphs: [
        'Write to {contact} at {email}, or send a request from the Privacy page of your account. We answer within 90 days, and sooner when we can.',
        'If you are not satisfied with our answer, you can complain to the Data Protection Board of India.',
      ],
      items: [],
    },
    {
      id: 'changes',
      heading: 'Changes to this notice',
      paragraphs: ['When we change this notice, the builder shows you the new version and records that you saw it. This is version {version}.'],
      items: [],
    },
  ],
};

export interface NoticeSection {
  id: string;
  heading: string;
  paragraphs: string[];
  items: string[];
}

export interface PlatformNotice {
  version: string;
  locale: string;
  title: string;
  fiduciary: string;
  contact: { name: string | null; email: string };
  sections: NoticeSection[];
  /** SHA-256 (hex) of the text as shown, contact details included: what an acknowledgement records. */
  hash: string;
}

/** The notice as this deployment shows it, with its operator and privacy contact filled in. */
export function renderNotice(privacy: PrivacyConfig): PlatformNotice {
  const fill = (s: string) =>
    s
      .replaceAll('{fiduciary}', privacy.fiduciaryName)
      .replaceAll('{contact}', privacy.contactName ?? 'our privacy contact')
      .replaceAll('{email}', privacy.contactEmail)
      .replaceAll('{version}', NOTICE_VERSION);
  const sections = NOTICE_TEMPLATE.sections.map((s) => ({ id: s.id, heading: s.heading, paragraphs: s.paragraphs.map(fill), items: s.items.map(fill) }));
  const body = { version: NOTICE_VERSION, locale: NOTICE_LOCALE, title: NOTICE_TEMPLATE.title, sections };
  return {
    ...body,
    fiduciary: privacy.fiduciaryName,
    contact: { name: privacy.contactName, email: privacy.contactEmail },
    hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
}

/**
 * Records that the user was shown this notice (once per text) and audits it on the platform chain. Runs inside the
 * user's own transaction: at sign-up with the account it creates, later from the settings.
 */
export async function recordNoticeAck(
  tx: Tx,
  o: { userId: string; notice: PlatformNotice; context: NoticeAckContext; client: ClientInfo; sessionId?: string | null },
): Promise<boolean> {
  const rows = await tx
    .insert(userNoticeAcks)
    .values({
      id: randomUUID(),
      userId: o.userId,
      noticeVersion: o.notice.version,
      noticeHash: Buffer.from(o.notice.hash, 'hex'),
      locale: o.notice.locale,
      context: o.context,
    })
    .onConflictDoNothing()
    .returning({ id: userNoticeAcks.id });
  if (rows.length === 0) return false;
  await audit.append(tx, PLATFORM_ORG_KEY, {
    actorKind: 'user',
    actorId: o.userId,
    sessionId: o.sessionId ?? null,
    actorIpHash: hex(o.client.ipHash),
    actorUa: o.client.ua,
    action: 'account.notice_acknowledged',
    resourceType: 'user',
    resourceId: o.userId,
    outcome: 'success',
    requestId: o.client.requestId,
    metadata: { version: o.notice.version, hash: o.notice.hash, context: o.context },
  });
  return true;
}

/** The newest notice the user acknowledged, if any (inside the user's context). */
export async function latestNoticeAck(tx: Tx, userId: string): Promise<{ version: string; hash: string; acknowledgedAt: Date } | null> {
  const [row] = await tx
    .select({ version: userNoticeAcks.noticeVersion, hash: userNoticeAcks.noticeHash, acknowledgedAt: userNoticeAcks.acknowledgedAt })
    .from(userNoticeAcks)
    .where(eq(userNoticeAcks.userId, userId))
    .orderBy(desc(userNoticeAcks.acknowledgedAt))
    .limit(1);
  return row ? { version: row.version, hash: hex(row.hash), acknowledgedAt: row.acknowledgedAt } : null;
}
