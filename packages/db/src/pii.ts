import type { Tables } from './client.ts';

/**
 * PII coverage manifest (architecture §2.4, compliance tables): every table declares which columns carry
 * personal data and how erasure and retention treat them. `dsr.execute` and `retention.sweep` must cover
 * each entry when they land (C-M6); a test keeps this list in step with the tables.
 */
export interface PiiRule {
  /** Columns holding personal data or identifiers of a person (ids included). */
  columns: readonly string[];
  erase: 'delete' | 'pseudonymise' | 'ttl';
  retainBasis: string;
}

type TableName = Tables[keyof Tables]['_']['name'];

export const PII_COVERAGE: Record<TableName, PiiRule> = {
  orgs: { columns: [], erase: 'delete', retainBasis: 'org lifetime; org_purge() after the deletion cooling-off (CMP-17)' },
  users: {
    columns: ['email', 'email_norm', 'name', 'locale', 'password_hash', 'totp_secret_enc', 'recovery_code_hashes', 'last_login_at'],
    erase: 'pseudonymise',
    retainBasis: 'account lifetime; account deletion keeps a pseudonymous id for audit references (CMP-21)',
  },
  memberships: { columns: ['user_id'], erase: 'delete', retainBasis: 'until the member leaves or the account is deleted' },
  org_settings: { columns: ['updated_by'], erase: 'pseudonymise', retainBasis: 'org lifetime; the user id re-pointed on account deletion' },
  invites: {
    columns: ['email', 'email_norm', 'invited_by', 'accepted_by'],
    erase: 'delete',
    retainBasis: 'open until accepted, revoked or expired (30 days at most); closed invites go with retention.sweep (WP-1.22) or an erasure of the invitee',
  },
  sessions: {
    columns: ['user_id', 'ip_hash', 'ua_summary', 'last_seen_at'],
    erase: 'delete',
    retainBasis: '14 days at most (absolute expiry); revoked and expired rows are purged, and all go with the account',
  },
  user_identities: { columns: ['user_id', 'subject'], erase: 'delete', retainBasis: 'until unlinked or the account is deleted' },
  auth_tokens: { columns: ['user_id', 'data'], erase: 'ttl', retainBasis: 'minutes to a day: single-use email tokens and MFA tickets, purged once expired' },
  auth_throttle: { columns: ['key'], erase: 'ttl', retainBasis: 'one rate-limit window (at most a day); keyed hashes of IPs and addresses only' },
  user_notice_acks: {
    columns: ['user_id'],
    erase: 'pseudonymise',
    retainBasis: 'kept after account deletion against the pseudonymous user id: the record of which notice was given (CMP-21)',
  },
  user_grievances: {
    columns: ['user_id', 'message'],
    erase: 'pseudonymise',
    retainBasis: 'account lifetime; on deletion the message goes and the reference, category and dates stay against the pseudonymous id (CMP-21)',
  },
  forms: {
    columns: ['owner_user_id', 'updated_by'],
    erase: 'pseudonymise',
    retainBasis: 'org lifetime; on account deletion owner_user_id passes to an org owner, updated_by keeps the pseudonymous id',
  },
  form_drafts: { columns: ['draft', 'updated_by'], erase: 'delete', retainBasis: 'with the form' },
  form_versions: {
    columns: ['definition', 'published_by'],
    erase: 'delete',
    retainBasis: 'with the form; immutable after publish',
  },
  form_version_state: { columns: [], erase: 'delete', retainBasis: 'with the version, which is immutable and goes with the form' },
  form_access: {
    columns: [],
    erase: 'delete',
    retainBasis: 'with the form; the password column holds an argon2id hash of a password the form owner chose, no data of a person',
  },
  form_slugs: {
    columns: [],
    erase: 'delete',
    retainBasis: 'with the form; every slug stays reserved for the life of the form so old links keep resolving and no other org can claim them',
  },
  form_counters: { columns: [], erase: 'delete', retainBasis: 'with the form: one number per form' },
  form_favourites: {
    columns: ['user_id'],
    erase: 'delete',
    retainBasis: 'until the member unstars the form; deleted with the account (a trigger on users, migration 0020)',
  },
  submissions: {
    columns: ['answers', 'computed', 'meta', 'principal_bidx', 'assignee_id', 'tags', 'status_label'],
    erase: 'delete',
    retainBasis:
      'delete_after (received_at + 10 years as a placeholder until retention purposes, WP-1.22), unless legal_hold; retention.sweep and dsr.execute delete the row, which un-holds its files; moved there from form_submissions by migration 0021',
  },
  submission_idempotency: {
    columns: ['submission_id', 'request_hash'],
    erase: 'ttl',
    retainBasis:
      '24 hours (expires_at), then deleted by a system sweep; holds the id of the submission it answered and a digest of the request, never the answers',
  },
  form_id_counters: { columns: [], erase: 'delete', retainBasis: 'with the form: one number per unique-ID field and period' },
  form_files: {
    columns: ['name', 'sha256', 'submission_id', 'submission_received_at'],
    erase: 'delete',
    retainBasis: 'with the form or retention.sweep / dsr.execute, which also delete the stored bytes (file store, WP-1.14)',
  },
  audit_pending: { columns: ['event'], erase: 'ttl', retainBasis: 'seconds: moved into audit_log by audit.chain' },
  audit_log: {
    columns: ['actor_id', 'impersonator_id', 'session_id', 'api_key_id', 'actor_ip_hash', 'actor_ua', 'metadata'],
    erase: 'ttl',
    retainBasis: '13 months online, then exported to the WORM bucket (7 years by default); never edited (CMP-02)',
  },
  audit_heads: { columns: [], erase: 'ttl', retainBasis: 'chain lifetime: seq and hash of the last link' },
  audit_checkpoints: { columns: [], erase: 'ttl', retainBasis: 'with the chain: signed heads, also anchored in the WORM bucket or the SIEM' },
  audit_archives: { columns: [], erase: 'ttl', retainBasis: 'with the archived object (7 years by default)' },
  template_packs: { columns: ['imported_by'], erase: 'pseudonymise', retainBasis: 'while the pack is installed; the user id keeps the pseudonymous id' },
  templates: {
    columns: ['owner_user_id', 'created_by'],
    erase: 'pseudonymise',
    retainBasis: 'template lifetime; payloads hold no personal data (sanitiser, synthetic sample answers); user ids keep the pseudonymous id',
  },
  template_versions: {
    columns: ['created_by', 'reviewed_by', 'review_comment'],
    erase: 'pseudonymise',
    retainBasis: 'immutable once published (SOC 2 change evidence); user ids keep the pseudonymous id',
  },
  template_localizations: { columns: [], erase: 'delete', retainBasis: 'with the template version' },
  template_categories: { columns: [], erase: 'delete', retainBasis: 'org lifetime, or the system pack' },
  template_category_links: { columns: [], erase: 'delete', retainBasis: 'with the template' },
  brand_kits: { columns: ['updated_by'], erase: 'pseudonymise', retainBasis: 'org lifetime; the user id keeps the pseudonymous id' },
  form_template_bindings: { columns: ['applied_by'], erase: 'pseudonymise', retainBasis: 'with the form (lineage); the user id keeps the pseudonymous id' },
  template_fork_bindings: { columns: [], erase: 'delete', retainBasis: 'with the fork' },
  template_usages: { columns: ['user_id'], erase: 'ttl', retainBasis: '400 days (templates spec §9), then purged by retention.sweep' },
  template_stats_daily: { columns: [], erase: 'ttl', retainBasis: 'aggregates without user ids; cross-tenant rows only over at least 5 orgs' },
  template_signing_keys: { columns: ['added_by'], erase: 'pseudonymise', retainBasis: 'trust store lifetime; the user id keeps the pseudonymous id' },
  template_search_synonyms: { columns: [], erase: 'delete', retainBasis: 'org lifetime, or the system pack' },
  template_search_misses: { columns: ['q_norm'], erase: 'ttl', retainBasis: '90 days, then purged by retention.sweep; normalised queries may echo what a member typed' },
  captcha_redemptions: { columns: [], erase: 'ttl', retainBasis: 'until the challenge expires (10 minutes by default); hashes of server-made challenges only' },
  submission_search: {
    columns: ['doc'],
    erase: 'delete',
    retainBasis: 'with the submission: answer text of non-sensitive fields, removed with the submission or its erasure (dsr.execute)',
  },
};
