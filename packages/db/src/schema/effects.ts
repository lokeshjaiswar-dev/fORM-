import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { WebhookPayloadMapping } from '@form/schema';
import { bytea, ts, tsNull } from './columns.ts';
import { forms } from './forms.ts';
import { orgs } from './identity.ts';
import { submissions } from './submissions.ts';

/*
 * What a form sends out and the ledger of what left (migration 0023): sealed secrets, email senders, notifications and
 * their delivery log, webhooks and their delivery log, exports, and the disclosures ledger. WP-1.16 (notifications),
 * WP-1.17 (exports), WP-1.18 (webhooks); architecture §2.4.
 *
 * Every table forces RLS with its `<table>_tenant` policy, and restrictive policies narrow each command by permission
 * (named in each comment). INSERT is granted on whole tables (Drizzle's INSERT names every column and a column it names
 * without the privilege fails the statement); UPDATE is granted per column, so `.set({...})` only ever names columns the
 * migration allows.
 */

export const SECRET_KINDS = ['smtp', 'webhook_hmac'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

/**
 * A sealed secret: SMTP credentials or a webhook signing secret. `enc` is the output of `sealOrgSecret` (the per-secret
 * key wrapped under the org's KMS key, the id, kind and org as associated data). fr_app can write `enc` and never read it
 * back: `select *` and `returning *` fail with "permission denied", so select `secretPublicColumns`. A system context
 * opens one with `secretEnc()`. `meta` is what the UI may show (host and user name, the last four characters).
 * RLS: `secrets_tenant`, and `secrets_access` (a system job; `org.settings` for kind smtp; `data.route` for webhook_hmac).
 * Unique by (org, id, kind): a webhook or a sender points at a secret by all three, so a webhook can only name a
 * webhook_hmac secret and a sender only an smtp one (foreign-key checks bypass RLS, so the kind has to be in the key).
 */
export const secrets = pgTable(
  'secrets',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    kind: text('kind', { enum: SECRET_KINDS }).notNull(),
    /** Write-only for fr_app. */
    enc: jsonb('enc').$type<Record<string, unknown>>().notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: ts('created_at'),
    rotatedAt: tsNull('rotated_at'),
  },
  (t) => [unique('secrets_org_id_id_kind_key').on(t.orgId, t.id, t.kind)],
);

/** Every column of `secrets` fr_app may read: all but `enc`. */
export const secretPublicColumns = {
  id: secrets.id,
  orgId: secrets.orgId,
  kind: secrets.kind,
  meta: secrets.meta,
  createdAt: secrets.createdAt,
  rotatedAt: secrets.rotatedAt,
};

/**
 * An org's own sending mailbox (NOT-01). Its SMTP credentials are a `secrets` row of the same org and of kind smtp (composite
 * key (org, id, kind); `smtpSecretKind` is fixed to 'smtp', is never written and is not updatable). At most
 * one default per org. RLS: `email_senders_tenant`; no respondent reads; writes need `org.settings` or a system job.
 */
export const emailSenders = pgTable(
  'email_senders',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    name: text('name').notNull(),
    fromAddress: text('from_address').notNull(),
    fromName: text('from_name'),
    smtpSecretId: uuid('smtp_secret_id').notNull(),
    /** Always 'smtp': the kind half of the foreign key to `secrets`, so a sender cannot name a webhook_hmac secret. */
    smtpSecretKind: text('smtp_secret_kind', { enum: ['smtp'] }).notNull().default('smtp'),
    /** Set by a successful test send; cleared when the credentials change. */
    verifiedAt: tsNull('verified_at'),
    /** What the last failed test send said, scrubbed of the URL and credentials. */
    lastTestError: text('last_test_error'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    unique('email_senders_org_id_id_key').on(t.orgId, t.id),
    foreignKey({ name: 'email_senders_secret_fkey', columns: [t.orgId, t.smtpSecretId, t.smtpSecretKind], foreignColumns: [secrets.orgId, secrets.id, secrets.kind] }),
    uniqueIndex('email_senders_default_key').on(t.orgId).where(sql`${t.isDefault}`),
    index('email_senders_secret_idx').on(t.orgId, t.smtpSecretId),
  ],
);

export const NOTIFICATION_KINDS = ['owner', 'autoresponder'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** The `trigger` of `NotificationConfig` (@form/schema, NOT-08). */
export const NOTIFICATION_TRIGGERS = ['submitted', 'edited', 'payment_confirmed', 'appointment_reminder', 'workflow_step', 'draft_saved'] as const;
export type NotificationTrigger = (typeof NOTIFICATION_TRIGGERS)[number];

/**
 * A form's owner notification or autoresponder: live and unversioned. `config` is the `NotificationConfig` of @form/schema;
 * `kind`, `trigger`, `enabled`, `senderId` and `purposeIds` are copies the worker queries and the database enforces
 * (`purposeIds` is required and non-empty: a notification with no purpose would send every field). `rev` is the
 * compare-and-swap revision of PUT. RLS: `notifications_tenant`; no respondent reads; writes need `forms.edit` or a system job.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    trigger: text('trigger', { enum: NOTIFICATION_TRIGGERS }).notNull(),
    senderId: uuid('sender_id'),
    /** `NotificationConfig` (@form/schema). */
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    purposeIds: text('purpose_ids').array().notNull(),
    rev: integer('rev').notNull().default(1),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    check('notifications_purpose_ids_check', sql`cardinality(${t.purposeIds}) > 0 and array_position(${t.purposeIds}, null) is null and '' <> all (${t.purposeIds})`),
    foreignKey({ name: 'notifications_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] }),
    foreignKey({ name: 'notifications_sender_fkey', columns: [t.orgId, t.senderId], foreignColumns: [emailSenders.orgId, emailSenders.id] }),
    index('notifications_form_idx').on(t.orgId, t.formId),
    index('notifications_sender_idx').on(t.orgId, t.senderId).where(sql`${t.senderId} is not null`),
  ],
);

export const EMAIL_STATUSES = ['queued', 'sending', 'retrying', 'sent', 'failed'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/**
 * The delivery log of a notification's messages (NOT-04): one row per message, no body (the message is rendered again at
 * send time). `toDisplayMasked` is what a person may see; `toBidx` the blind indexes for a DSR lookup (null until WP-1.11);
 * `messageId` is the stable RFC 5322 Message-ID reused by every retry. `orgProfileUpdatedAt` and `brandTokensHash` record
 * which org profile and brand kit the live variables came from. Partitioned by month on `createdAt`, partitions in
 * schema `parts` (no default partition); the rows of a deleted response go with it (FK cascade), the rest at 365 days
 * (WP-1.22). RLS: `email_messages_tenant`; reads need `submissions.read` or a system job; only a system job writes.
 */
export const emailMessages = pgTable(
  'email_messages',
  {
    id: uuid('id').notNull(),
    createdAt: ts('created_at'),
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    submissionId: uuid('submission_id').notNull(),
    submissionReceivedAt: timestamp('submission_received_at', { withTimezone: true }).notNull(),
    notificationId: uuid('notification_id').notNull(),
    role: text('role').notNull(),
    toDisplayMasked: text('to_display_masked').array().notNull(),
    toBidx: bytea('to_bidx').array(),
    /** sha256 of the rendered subject, so the log shows two sends were the same without keeping the text. */
    subjectHash: bytea('subject_hash').notNull(),
    messageId: text('message_id').notNull(),
    status: text('status', { enum: EMAIL_STATUSES }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    providerMessageId: text('provider_message_id'),
    lastError: text('last_error'),
    orgProfileUpdatedAt: tsNull('org_profile_updated_at'),
    brandTokensHash: bytea('brand_tokens_hash'),
    sentAt: tsNull('sent_at'),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    foreignKey({ name: 'email_messages_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] }),
    foreignKey({
      name: 'email_messages_submission_fkey',
      columns: [t.submissionId, t.submissionReceivedAt],
      foreignColumns: [submissions.id, submissions.receivedAt],
    }).onDelete('cascade'),
    index('email_messages_form_idx').on(t.orgId, t.formId, t.createdAt.desc(), t.id.desc()),
    index('email_messages_submission_idx').on(t.submissionId, t.submissionReceivedAt),
  ],
);

/** The events a webhook may subscribe to (`WebhookConfig.events` in @form/schema). */
export const WEBHOOK_EVENTS = ['submission.created', 'submission.updated', 'submission.deleted', 'payment.succeeded', 'consent.withdrawn'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_KEY_BY = ['key', 'id'] as const;
export const WEBHOOK_BODY_FORMATS = ['json', 'xml'] as const;
export const WEBHOOK_FILES = ['signed_urls', 'none'] as const;

/**
 * A form's outgoing webhook (INT-01). Sending answers to an outside address is a disclosure, so `purposeIds` is required
 * and non-empty, and every command needs `data.route` (or a system job). `secretId` names the signing secret (kind
 * webhook_hmac, enforced by the foreign key through `secretKind`) of the same org. `fieldKeys` is `'all_in_purposes'` or the keys that narrow the purpose filter further.
 * `consecutiveFailures` and `disabledReason` are the auto-disable after 50 failures. `rev` is the CAS revision of PUT.
 * RLS: `webhooks_tenant`, and `webhooks_data_route`.
 */
export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    url: text('url').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    secretId: uuid('secret_id').notNull(),
    /** Always 'webhook_hmac': the kind half of the foreign key to `secrets`, so a webhook cannot name an smtp secret. */
    secretKind: text('secret_kind', { enum: ['webhook_hmac'] }).notNull().default('webhook_hmac'),
    events: text('events', { enum: WEBHOOK_EVENTS }).array().notNull(),
    keyBy: text('key_by', { enum: WEBHOOK_KEY_BY }).notNull().default('key'),
    fieldKeys: jsonb('field_keys').$type<string[] | 'all_in_purposes'>().notNull().default(sql`'"all_in_purposes"'::jsonb`),
    purposeIds: text('purpose_ids').array().notNull(),
    files: text('files', { enum: WEBHOOK_FILES }).notNull().default('none'),
    /** 'json' (the standard payload when `payloadMapping` is null) or 'xml'. Migration 0025. */
    bodyFormat: text('body_format', { enum: WEBHOOK_BODY_FORMATS }).notNull().default('json'),
    /** `WebhookPayloadMapping` of @form/schema, validated by the API on save and again by the worker. Null = the standard payload. */
    payloadMapping: jsonb('payload_mapping').$type<WebhookPayloadMapping | null>(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    disabledReason: text('disabled_reason'),
    rev: integer('rev').notNull().default(1),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    unique('webhooks_org_id_id_key').on(t.orgId, t.id),
    check('webhooks_purpose_ids_check', sql`cardinality(${t.purposeIds}) > 0 and array_position(${t.purposeIds}, null) is null and '' <> all (${t.purposeIds})`),
    foreignKey({ name: 'webhooks_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] }),
    foreignKey({ name: 'webhooks_secret_fkey', columns: [t.orgId, t.secretId, t.secretKind], foreignColumns: [secrets.orgId, secrets.id, secrets.kind] }),
    index('webhooks_form_idx').on(t.orgId, t.formId),
    index('webhooks_secret_idx').on(t.orgId, t.secretId),
  ],
);

export const DELIVERY_STATUSES = ['pending', 'retrying', 'succeeded', 'failed', 'dead'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * One delivery of one event to one webhook, updated as it is tried; a replay is a new row whose `replayOf` names the
 * original. `requestHash` is the sha256 of the body that was sent (the body is not kept); `responseSnippet` is at most 1 KB
 * of the receiver's answer, scrubbed, nulled after 30 days (WP-1.22). The submission is deliberately not a foreign key
 * (a `submission.deleted` delivery outlives its response); both columns are set or both null. Deleting the webhook
 * deletes its deliveries. Partitioned by month on `createdAt`, like `emailMessages`. RLS: `webhook_deliveries_tenant`;
 * reads and inserts (a replay) need `data.route` or a system job; only a system job updates or deletes.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').notNull(),
    createdAt: ts('created_at'),
    orgId: uuid('org_id').notNull(),
    webhookId: uuid('webhook_id').notNull(),
    event: text('event', { enum: WEBHOOK_EVENTS }).notNull(),
    submissionId: uuid('submission_id'),
    submissionReceivedAt: tsNull('submission_received_at'),
    attempt: integer('attempt').notNull().default(0),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull().default('pending'),
    httpStatus: integer('http_status'),
    durationMs: integer('duration_ms'),
    requestHash: bytea('request_hash'),
    responseSnippet: text('response_snippet'),
    replayOf: uuid('replay_of'),
    nextAttemptAt: tsNull('next_attempt_at'),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    check('webhook_deliveries_submission_pair', sql`(${t.submissionId} is null) = (${t.submissionReceivedAt} is null)`),
    foreignKey({ name: 'webhook_deliveries_webhook_fkey', columns: [t.orgId, t.webhookId], foreignColumns: [webhooks.orgId, webhooks.id] }).onDelete('cascade'),
    index('webhook_deliveries_webhook_idx').on(t.orgId, t.webhookId, t.createdAt.desc(), t.id.desc()),
  ],
);

export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_STATUSES = ['queued', 'running', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** Which responses an export covers. Ids and dates only, never answers. */
export type ExportScope = { kind: 'all' } | { kind: 'selected'; ids: string[] } | { kind: 'filtered'; from?: string; to?: string };

/**
 * An export job (EXP-01). The API inserts a queued row (a member inserts only that: no object, size or state of the file)
 * and the `export.build` job writes the rest. `includeSensitive` needs a `reason` (a check). `idempotencyKey` is the client's
 * Idempotency-Key, unique per org, so a repeat finds the same export. The file is in the `exports` bucket at `objectKey`
 * until `expiresAt`. RLS: `exports_tenant`; reading and asking need `submissions.export` or a system job; only a system job
 * updates or deletes.
 */
export const exportJobs = pgTable(
  'exports',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    format: text('format', { enum: EXPORT_FORMATS }).notNull(),
    scope: jsonb('scope').$type<ExportScope>().notNull(),
    includeSensitive: boolean('include_sensitive').notNull().default(false),
    reason: text('reason'),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status', { enum: EXPORT_STATUSES }).notNull().default('queued'),
    rowCount: bigint('row_count', { mode: 'number' }),
    objectKey: text('object_key'),
    bytes: bigint('bytes', { mode: 'number' }),
    error: text('error'),
    createdAt: ts('created_at'),
    finishedAt: tsNull('finished_at'),
    expiresAt: tsNull('expires_at'),
  },
  (t) => [
    unique('exports_idempotency_key').on(t.orgId, t.idempotencyKey),
    check('exports_sensitive_reason_check', sql`not ${t.includeSensitive} or (${t.reason} is not null and ${t.reason} ~ '[^[:space:]]')`),
    foreignKey({ name: 'exports_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] }),
    index('exports_form_idx').on(t.orgId, t.formId, t.createdAt.desc()),
    index('exports_active_idx').on(t.orgId).where(sql`${t.status} in ('queued', 'running')`),
    index('exports_created_idx').on(t.orgId, t.createdAt.desc()),
    index('exports_expiry_idx').on(t.expiresAt).where(sql`${t.status} = 'ready'`),
  ],
);

export const DISCLOSURE_RECIPIENT_KINDS = ['notification', 'webhook', 'export'] as const;
export type DisclosureRecipientKind = (typeof DISCLOSURE_RECIPIENT_KINDS)[number];

/**
 * The ledger of who received which fields of which response (DPDP s.11(1)(b)): the field keys, never values. Append-only
 * for fr_app, which has SELECT and INSERT and no UPDATE or DELETE privilege (a "permission denied" for everyone); a row
 * lives as long as its response, which deletes it (the FK cascade runs as the table owner). RLS: `disclosures_tenant`;
 * any context of the org may add a row, reading needs `submissions.read`, `compliance.dsr` or a system job.
 */
export const disclosures = pgTable(
  'disclosures',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    submissionId: uuid('submission_id').notNull(),
    submissionReceivedAt: timestamp('submission_received_at', { withTimezone: true }).notNull(),
    recipientKind: text('recipient_kind', { enum: DISCLOSURE_RECIPIENT_KINDS }).notNull(),
    /** The notification, webhook or export that received the data. */
    recipientId: uuid('recipient_id').notNull(),
    /** What a person reads in the ledger: a masked address, a webhook host, "CSV export". */
    displayName: text('display_name').notNull(),
    fieldKeys: text('field_keys').array().notNull().default(sql`'{}'`),
    at: ts('at'),
  },
  (t) => [
    foreignKey({
      name: 'disclosures_submission_fkey',
      columns: [t.submissionId, t.submissionReceivedAt],
      foreignColumns: [submissions.id, submissions.receivedAt],
    }).onDelete('cascade'),
    index('disclosures_submission_idx').on(t.submissionId, t.submissionReceivedAt),
    index('disclosures_recipient_idx').on(t.orgId, t.recipientKind, t.recipientId, t.at.desc()),
  ],
);
