import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea, ts, tsNull } from './columns.ts';
import { orgs, users } from './identity.ts';

/** The date formats an org may default to (`orgs_date_format_known`; the list of `SUPPORTED_DATE_PATTERNS` in @form/i18n). */
export const ORG_DATE_FORMATS = ['DD-MM-YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'D MMM YYYY', 'MMMM D, YYYY'] as const;
export type OrgDateFormat = (typeof ORG_DATE_FORMATS)[number];

/** WSP-09: what a new org starts with. */
export const ORG_DEFAULTS = { locale: 'en-IN', timeZone: 'Asia/Kolkata', dateFormat: 'DD-MM-YYYY' } as const;

/** The roles assignable in P1 (and by invite); `memberships` already allows the P2 roles. */
export const ORG_ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const MEMBERSHIP_STATUSES = ['active', 'suspended'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** RLS: `org_settings_tenant`; writes need `org.settings`. One row per org (create_org()). */
export const orgSettings = pgTable('org_settings', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => orgs.id),
  editorsApproveNotice: boolean('editors_approve_notice').notNull().default(false),
  inviteDays: integer('invite_days').notNull().default(7),
  updatedAt: ts('updated_at'),
  updatedBy: uuid('updated_by').references(() => users.id),
});

/**
 * RLS: `invites_tenant`, and `members.manage` for any access. Only the SHA-256 of the link token is stored and
 * fr_app cannot read it (select explicit columns, `invitePublicColumns`); links go through `invite_by_token()` and
 * `invite_accept()`.
 */
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id),
  email: text('email').notNull(),
  emailNorm: text('email_norm').notNull(),
  role: text('role', { enum: ORG_ROLES }).notNull(),
  teamIds: uuid('team_ids').array().notNull().default(sql`'{}'`),
  tokenHash: bytea('token_hash').notNull().unique(),
  invitedBy: uuid('invited_by')
    .notNull()
    .references(() => users.id),
  createdAt: ts('created_at'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: tsNull('accepted_at'),
  acceptedBy: uuid('accepted_by').references(() => users.id),
  revokedAt: tsNull('revoked_at'),
});

export const invitePublicColumns = {
  id: invites.id,
  orgId: invites.orgId,
  email: invites.email,
  emailNorm: invites.emailNorm,
  role: invites.role,
  invitedBy: invites.invitedBy,
  createdAt: invites.createdAt,
  expiresAt: invites.expiresAt,
  acceptedAt: invites.acceptedAt,
  revokedAt: invites.revokedAt,
};
