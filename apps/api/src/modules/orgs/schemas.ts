import { randomBytes } from 'node:crypto';
import { MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES, ORG_DATE_FORMATS, ORG_ROLES, ORG_STATUSES } from '@form/db';
import { z } from 'zod';

/** Lower-case letters, digits and inner hyphens, 1–63 characters (`orgs_slug_format`). */
export const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const orgNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\p{Cc}]+$/u, 'must not contain control characters');

export const slugSchema = z.string().regex(SLUG, 'lower-case letters, digits and hyphens, not at either end');

function canonicalLocale(tag: string): string | null {
  try {
    const [canonical] = Intl.getCanonicalLocales(tag);
    return canonical && /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

/** A BCP 47 tag, stored in its canonical form (`en-in` becomes `en-IN`). */
export const localeSchema = z
  .string()
  .max(35)
  .transform((tag, ctx) => {
    const canonical = canonicalLocale(tag);
    if (canonical === null) {
      ctx.addIssue({ code: 'custom', message: 'expected a language tag such as en-IN' });
      return z.NEVER;
    }
    return canonical;
  });

function knownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-IN', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** An IANA time zone (`Asia/Kolkata`, `UTC`). */
export const timeZoneSchema = z.string().min(1).max(64).refine(knownTimeZone, 'expected an IANA time zone such as Asia/Kolkata');

export const dateFormatSchema = z.enum(ORG_DATE_FORMATS);

export const orgView = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  plan: z.string(),
  region: z.string(),
  locale: z.string(),
  timeZone: z.string(),
  dateFormat: z.enum(ORG_DATE_FORMATS),
  status: z.enum(ORG_STATUSES),
  createdAt: z.iso.datetime({ offset: true }),
});
export type OrgView = z.infer<typeof orgView>;

export const userOrg = z.object({ id: z.uuid(), slug: z.string(), name: z.string(), role: z.enum(MEMBERSHIP_ROLES) });

export const settingsView = z.object({
  /** CMP-24: editors may approve privacy notices too. */
  editorsApproveNotice: z.boolean(),
  /** How long an invite link works, in days. */
  inviteDays: z.number().int().min(1).max(30),
});

export const memberView = z.object({
  userId: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.enum(MEMBERSHIP_ROLES),
  status: z.enum(MEMBERSHIP_STATUSES),
  joinedAt: z.iso.datetime({ offset: true }),
});

export const inviteView = z.object({
  id: z.uuid(),
  email: z.string(),
  role: z.enum(ORG_ROLES),
  invitedBy: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  state: z.enum(['open', 'expired']),
});

export const orgRoleSchema = z.enum(ORG_ROLES);

/** A slug from an org name: ASCII letters and digits, hyphens between words (`Acme Pvt. Ltd.` → `acme-pvt-ltd`). */
export function slugFrom(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return base.length > 0 ? base : 'org';
}

/** The slug with a short random suffix, for a second try when the plain one is taken. */
export const withSuffix = (slug: string) => `${slug.slice(0, 54)}-${randomBytes(3).toString('hex')}`;
