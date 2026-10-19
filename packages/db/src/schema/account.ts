import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { bytea, ts, tsNull } from './columns.ts';
import { users } from './identity.ts';

export const NOTICE_ACK_CONTEXTS = ['signup', 'oauth_signup', 'settings'] as const;
export type NoticeAckContext = (typeof NOTICE_ACK_CONTEXTS)[number];

export const GRIEVANCE_CATEGORIES = ['information', 'correction', 'erasure', 'nomination', 'complaint', 'other'] as const;
export type GrievanceCategory = (typeof GRIEVANCE_CATEGORIES)[number];

export const GRIEVANCE_STATUSES = ['open', 'answered', 'closed'] as const;
export type GrievanceStatus = (typeof GRIEVANCE_STATUSES)[number];

/**
 * The platform privacy notice texts a user acknowledged (CMP-21), append-only. RLS: `user_notice_acks_self` (a user
 * actor's own rows). Kept after account deletion against the pseudonymous id.
 */
export const userNoticeAcks = pgTable(
  'user_notice_acks',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    noticeVersion: text('notice_version').notNull(),
    noticeHash: bytea('notice_hash').notNull(),
    locale: text('locale').notNull(),
    context: text('context', { enum: NOTICE_ACK_CONTEXTS }).notNull(),
    acknowledgedAt: ts('acknowledged_at'),
  },
  (t) => [unique('user_notice_acks_user_id_notice_hash_key').on(t.userId, t.noticeHash)],
);

/** Privacy requests and grievances a builder user sent the platform's privacy contact. RLS: `user_grievances_self`. */
export const userGrievances = pgTable(
  'user_grievances',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    reference: text('reference').notNull().unique(),
    category: text('category', { enum: GRIEVANCE_CATEGORIES }).notNull(),
    message: text('message'),
    status: text('status', { enum: GRIEVANCE_STATUSES }).notNull().default('open'),
    createdAt: ts('created_at'),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    closedAt: tsNull('closed_at'),
  },
  (t) => [index('user_grievances_user_id_idx').on(t.userId, t.createdAt.desc())],
);
