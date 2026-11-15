import { and, eq, inArray } from 'drizzle-orm';
import { forms, memberships, users, type Tx } from '@form/db';
import type { MailAddress } from '@form/ports';
import type { NotificationConfig, Recipient } from '@form/schema';
import type { DisclosableField } from '../disclosure.ts';
import { isControl, replaceControls } from './render.ts';

/*
 * Who a notification goes to (WP-1.16, NOT-02/03/04). A `Recipient` of the notification's config is turned into mail
 * addresses at the moment of sending, never earlier and never from the client:
 *   - `email`: the literal address the form's editor typed (the API held it behind `data.route` when it was saved);
 *   - `field`: the respondent's answer to an email field, and only when that answer is something `disclosableFields` lets
 *     this notification have. A field outside the notification's purposes, omitted, masked or not answered gives nobody,
 *     so an autoresponder can never mail an address the respondent did not give for that purpose;
 *   - `member`: an active member of THIS org whose email is verified (a user id that belongs to another org, or to nobody,
 *     gives nobody: the lookup is the org's memberships under RLS);
 *   - `role`: `form_owner` (the form's owner, if still an active member) and `org_admins` (the active owners and admins).
 *     `team_admins` has no team model yet and gives nobody.
 * Recipients that cannot be mailed (an unusable address, a person who has left, a masked answer) are skipped and counted,
 * and the caller decides what an empty list means. Addresses are never logged.
 */

export interface RecipientContext {
  orgId: string;
  formId: string;
  /** The answers `disclosableFields` allowed this notification; a `field` recipient reads its address from here and nowhere else. */
  fields: readonly DisclosableField[];
}

export interface ResolvedRecipients {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo?: MailAddress;
  /** Recipients of the config that gave no address: left out for one of the reasons above. */
  skipped: number;
}

type RecipientLists = Pick<NotificationConfig, 'to' | 'cc' | 'bcc' | 'replyTo'>;

/** RFC 5321 caps an address at 254 characters. */
const MAX_ADDRESS = 254;
/** No whitespace, no header-breaking or quoting characters; one `@`; a dot in the domain. Control characters are checked apart (`isControl`). */
const MAILABLE = /^[^\s@<>(),;:\\"[\]]+@[^\s@<>(),;:\\"[\]]+$/u;

/** An address worth handing to the mailer. The mailer refuses the rest with `invalid_argument`, which would fail the whole message. */
export function isMailable(address: string): boolean {
  if (address.length === 0 || address.length > MAX_ADDRESS || !MAILABLE.test(address) || [...address].some((c) => isControl(c.codePointAt(0)!))) return false;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.') && !domain.includes('..');
}

/**
 * What the delivery log and the disclosures ledger show of an address: the first character, three stars and the domain
 * (`a***@example.com`). The ledger names a recipient well enough for a person to recognise theirs without keeping the address.
 */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return '***';
  return `${[...address.slice(0, at)][0]}***${address.slice(at)}`;
}

/** A display name that cannot break a header (no control characters, line breaks included); blank becomes no name. */
function cleanName(name: string | null | undefined): string | undefined {
  const cleaned = replaceControls(name ?? '').trim().slice(0, 200);
  return cleaned === '' ? undefined : cleaned;
}

interface Member {
  userId: string;
  address: string;
  name: string | undefined;
}

/** Active members of the org with a verified email: the only people a notification may name by id or by role. */
async function loadMembers(tx: Tx, orgId: string, o: { userIds?: string[]; roles?: Array<'owner' | 'admin'> }): Promise<Member[]> {
  const conditions = [eq(memberships.orgId, orgId), eq(memberships.status, 'active'), eq(users.status, 'active')];
  if (o.userIds) conditions.push(inArray(memberships.userId, o.userIds));
  if (o.roles) conditions.push(inArray(memberships.role, o.roles));
  const rows = await tx
    .select({ userId: users.id, address: users.email, name: users.name, verifiedAt: users.emailVerifiedAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(...conditions))
    // A stable order, so the To line of a message and the delivery log do not depend on the plan the database chose.
    .orderBy(users.emailNorm);
  return rows.filter((r) => r.verifiedAt !== null && isMailable(r.address)).map((r) => ({ userId: r.userId, address: r.address, name: cleanName(r.name) }));
}

const asMail = (m: Member): MailAddress => (m.name === undefined ? { address: m.address } : { address: m.address, name: m.name });

/** The address a `field` recipient reads: an email answer that was disclosed in the clear. */
function fieldAddress(fields: readonly DisclosableField[], blockId: string): string | undefined {
  const field = fields.find((f) => f.blockId === blockId);
  if (!field || field.type !== 'email' || field.masked || !field.answered) return undefined;
  const value = field.value as { address?: unknown } | null | undefined;
  return typeof value?.address === 'string' ? value.address.trim() : undefined;
}

/**
 * The addresses of a notification's `to`, `cc`, `bcc` and `replyTo`, in the order the config lists them. An address that
 * appears twice is kept once, in the highest of to, cc and bcc (a person is never told in `cc` what `to` already said).
 * Runs in the caller's tenant transaction (the job's `tx` or an `inTenant`).
 */
export async function resolveRecipients(tx: Tx, lists: RecipientLists, ctx: RecipientContext): Promise<ResolvedRecipients> {
  const every = [...lists.to, ...(lists.cc ?? []), ...(lists.bcc ?? []), ...(lists.replyTo ? [lists.replyTo] : [])];
  const memberIds = [...new Set(every.flatMap((r) => (r.kind === 'member' ? [r.userId as string] : [])))];
  const wantRoles = new Set(every.flatMap((r) => (r.kind === 'role' ? [r.role] : [])));

  // One lookup per kind for the whole config, not one per recipient.
  const byId = new Map<string, Member>();
  if (memberIds.length > 0) for (const m of await loadMembers(tx, ctx.orgId, { userIds: memberIds })) byId.set(m.userId, m);
  let admins: Member[] = [];
  if (wantRoles.has('org_admins')) admins = await loadMembers(tx, ctx.orgId, { roles: ['owner', 'admin'] });
  let formOwner: Member | undefined;
  if (wantRoles.has('form_owner')) {
    const [form] = await tx.select({ owner: forms.ownerUserId }).from(forms).where(and(eq(forms.orgId, ctx.orgId), eq(forms.id, ctx.formId))).limit(1);
    if (form) formOwner = (await loadMembers(tx, ctx.orgId, { userIds: [form.owner] }))[0];
  }

  const resolveOne = (r: Recipient): MailAddress[] => {
    switch (r.kind) {
      case 'email':
        return isMailable(r.address) ? [{ address: r.address }] : [];
      case 'field': {
        const address = fieldAddress(ctx.fields, r.blockId);
        return address !== undefined && isMailable(address) ? [{ address }] : [];
      }
      case 'member': {
        const m = byId.get(r.userId);
        return m ? [asMail(m)] : [];
      }
      case 'role':
        if (r.role === 'org_admins') return admins.map(asMail);
        if (r.role === 'form_owner') return formOwner ? [asMail(formOwner)] : [];
        return [];
      default:
        return [];
    }
  };

  let skipped = 0;
  const seen = new Set<string>();
  const collect = (recipients: readonly Recipient[] | undefined): MailAddress[] => {
    const out: MailAddress[] = [];
    for (const r of recipients ?? []) {
      const found = resolveOne(r);
      if (found.length === 0) skipped += 1;
      for (const a of found) {
        const key = a.address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(a);
      }
    }
    return out;
  };

  const to = collect(lists.to);
  const cc = collect(lists.cc);
  const bcc = collect(lists.bcc);
  // Reply-To is a header, not a delivery: it may repeat an address that is also a recipient.
  const replyTo = lists.replyTo ? resolveOne(lists.replyTo)[0] : undefined;
  if (lists.replyTo && replyTo === undefined) skipped += 1;
  return { to, cc, bcc, ...(replyTo ? { replyTo } : {}), skipped };
}

/** Every address of a resolved set that is delivered to (not Reply-To), in the order to, cc, bcc. */
export const deliveredTo = (r: Pick<ResolvedRecipients, 'to' | 'cc' | 'bcc'>): MailAddress[] => [...r.to, ...r.cc, ...r.bcc];
