import { integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea, ts, tsNull } from './columns.ts';
import { orgs, users } from './identity.ts';

/** First factor, then the second when one was used: `pwd`, `link+totp`, `oauth+recovery`, … (`sso` in P3). */
export const FIRST_FACTORS = ['pwd', 'link', 'oauth', 'sso'] as const;
export const SECOND_FACTORS = ['totp', 'recovery'] as const;
export type FirstFactor = (typeof FIRST_FACTORS)[number];
export type SecondFactor = (typeof SECOND_FACTORS)[number];
export type MfaLevel = FirstFactor | `${FirstFactor}+${SecondFactor}`;

export const SESSION_REVOKE_REASONS = ['logout', 'rotated', 'revoked', 'password_reset', 'mfa_enabled', 'mfa_disabled', 'role_changed'] as const;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

export const OAUTH_PROVIDERS = ['google', 'microsoft'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export const AUTH_TOKEN_PURPOSES = ['verify_email', 'magic_link', 'password_reset', 'mfa'] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

/**
 * Server-side sessions (`__Host-fr_sess`); only the SHA-256 of the token is stored. RLS: `sessions_self` (a user
 * actor's own rows). Lookup by token only through `auth_session()`; fr_app cannot read `token_hash` or `ip_hash`.
 */
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  tokenHash: bytea('token_hash').notNull().unique(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  activeOrgId: uuid('active_org_id').references(() => orgs.id),
  mfaLevel: text('mfa_level').$type<MfaLevel>().notNull(),
  ipHash: bytea('ip_hash'),
  uaSummary: text('ua_summary'),
  createdAt: ts('created_at'),
  lastSeenAt: ts('last_seen_at'),
  idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  revokedAt: tsNull('revoked_at'),
  revokedReason: text('revoked_reason', { enum: SESSION_REVOKE_REASONS }),
});

/** Google and Microsoft accounts linked to a user. RLS: `user_identities_self`; lookup through `auth_identity_user()`. */
export const userIdentities = pgTable(
  'user_identities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    provider: text('provider', { enum: OAUTH_PROVIDERS }).notNull(),
    subject: text('subject').notNull(),
    createdAt: ts('created_at'),
    lastUsedAt: tsNull('last_used_at'),
  },
  (t) => [uniqueIndex('user_identities_provider_subject_key').on(t.provider, t.subject)],
);

/** Single-use email tokens and MFA tickets (SHA-256 only). RLS: `auth_tokens_self`; redeemed through `auth_token_take()`. */
export const authTokens = pgTable('auth_tokens', {
  id: uuid('id').primaryKey(),
  tokenHash: bytea('token_hash').notNull().unique(),
  purpose: text('purpose', { enum: AUTH_TOKEN_PURPOSES }).notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: tsNull('consumed_at'),
  createdAt: ts('created_at'),
});

/** Fixed-window counters of the auth_* rate-limit buckets (UNLOGGED). No fr_app privilege; `auth_throttle_hit()` only. */
export const authThrottle = pgTable(
  'auth_throttle',
  {
    bucket: text('bucket').notNull(),
    key: bytea('key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    hits: integer('hits').notNull(),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.key, t.windowStart] })],
);
