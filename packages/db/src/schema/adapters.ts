import { customType, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea, ts } from './columns.ts';
import { orgs } from './identity.ts';

/** Written and read as SQL (`to_tsvector`, `@@`); drizzle only needs the column to exist. */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** Redeemed proof-of-work challenges, kept until they expire (ADR-0011). RLS: `captcha_redemptions_tenant`. */
export const captchaRedemptions = pgTable(
  'captcha_redemptions',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    challengeHash: bytea('challenge_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    redeemedAt: ts('redeemed_at'),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.challengeHash] }), index('captcha_redemptions_expires_idx').on(t.orgId, t.expiresAt)],
);

/**
 * The Postgres FTS index of non-sensitive answers (architecture §2.4), partitioned by month on `received_at` like
 * submissions; partitions live in schema `parts`. RLS: `submission_search_tenant`.
 */
export const submissionSearch = pgTable(
  'submission_search',
  {
    submissionId: uuid('submission_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    locale: text('locale').notNull(),
    doc: tsvector('doc').notNull(),
    updatedAt: ts('updated_at'),
  },
  (t) => [primaryKey({ columns: [t.submissionId, t.receivedAt] })],
);
