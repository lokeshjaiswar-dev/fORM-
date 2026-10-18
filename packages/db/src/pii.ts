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
  forms: { columns: ['owner_user_id', 'updated_by'], erase: 'pseudonymise', retainBasis: 'org lifetime; user ids re-pointed on account deletion' },
  form_drafts: { columns: ['draft', 'updated_by'], erase: 'delete', retainBasis: 'with the form' },
  audit_pending: { columns: ['event'], erase: 'ttl', retainBasis: 'seconds: moved into audit_log by audit.chain' },
  audit_log: {
    columns: ['actor_id', 'impersonator_id', 'session_id', 'api_key_id', 'actor_ip_hash', 'actor_ua', 'metadata'],
    erase: 'ttl',
    retainBasis: '13 months online, then exported to the WORM bucket (7 years by default); never edited (CMP-02)',
  },
};
