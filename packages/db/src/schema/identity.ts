import { bigint, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { ts, tsNull } from './columns.ts';

export const ORG_STATUSES = ['active', 'suspended', 'pending_deletion', 'deleted'] as const;
export const MEMBERSHIP_ROLES = ['owner', 'admin', 'editor', 'viewer', 'creator', 'data_collaborator', 'data_viewer'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/** RLS: `orgs_tenant` (select own org), `orgs_tenant_update`. */
export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  plan: text('plan').notNull().default('free'),
  region: text('region').notNull().default('in-mum-1'),
  locale: text('locale').notNull().default('en-IN'),
  timeZone: text('time_zone').notNull().default('Asia/Kolkata'),
  dateFormat: text('date_format').notNull().default('DD-MM-YYYY'),
  status: text('status', { enum: ORG_STATUSES }).notNull().default('active'),
  deletionScheduledAt: tsNull('deletion_scheduled_at'),
  createdAt: ts('created_at'),
});

/**
 * Global identity. RLS: `users_visible`, `users_self_update`. fr_app has column grants only; credential
 * columns are unreadable (select explicit columns, `userPublicColumns`) and are read through
 * `auth_user_by_email()` and `auth_user_credentials()`. A user may update their own credential columns.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  emailNorm: text('email_norm').notNull().unique(),
  emailVerifiedAt: tsNull('email_verified_at'),
  name: text('name'),
  locale: text('locale'),
  passwordHash: text('password_hash'),
  totpSecretEnc: jsonb('totp_secret_enc'),
  totpEnabledAt: tsNull('totp_enabled_at'),
  recoveryCodeHashes: text('recovery_code_hashes').array(),
  status: text('status').notNull().default('active'),
  lastLoginAt: tsNull('last_login_at'),
  createdAt: ts('created_at'),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  /** Set with status `deleted`: the row is then a pseudonymous tombstone (`account_delete()`, CMP-21). */
  deletedAt: tsNull('deleted_at'),
});

export const userPublicColumns = {
  id: users.id,
  email: users.email,
  emailNorm: users.emailNorm,
  emailVerifiedAt: users.emailVerifiedAt,
  name: users.name,
  locale: users.locale,
  status: users.status,
  totpEnabledAt: users.totpEnabledAt,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
};

/** RLS: `memberships_tenant`. */
export const memberships = pgTable(
  'memberships',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: MEMBERSHIP_ROLES }).notNull(),
    customRoleId: uuid('custom_role_id'),
    status: text('status').notNull().default('active'),
    createdAt: ts('created_at'),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);
