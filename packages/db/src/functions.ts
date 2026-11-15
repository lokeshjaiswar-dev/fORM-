import { sql } from 'drizzle-orm';
import type { Executor } from './client.ts';
import { pgArray } from './tenant.ts';
import type { MembershipRole } from './schema/index.ts';

/** Typed calls of the SECURITY DEFINER functions in migration 0003. */

export const ORG_SPANNING_JOBS = [
  'retention.sweep',
  'drafts.expire',
  'analytics.rollup',
  'audit.checkpoint',
  'payment.reconcile',
  'billing.meter',
  'kms.rotate',
  'dsr.overdue',
] as const;
export type OrgSpanningJob = (typeof ORG_SPANNING_JOBS)[number];

/** `audit_chain` resolves to its own org key (the zero key for the platform chain). */
export const JOB_RESOURCE_TYPES = ['org', 'form', 'form_draft', 'audit_chain'] as const;
export type JobResourceType = (typeof JOB_RESOURCE_TYPES)[number];

export const PARTITIONED_TABLES = ['audit_log', 'submission_search', 'submissions'] as const;
export type PartitionedTable = (typeof PARTITIONED_TABLES)[number];

export interface UserOrg {
  orgId: string;
  slug: string;
  name: string;
  role: MembershipRole;
}

export async function listUserOrgs(db: Executor, userId: string): Promise<UserOrg[]> {
  const { rows } = await db.execute<{ org_id: string; slug: string; name: string; role: MembershipRole }>(
    sql`select org_id, slug, name, role from list_user_orgs(${userId}::uuid)`,
  );
  return rows.map((r) => ({ orgId: r.org_id, slug: r.slug, name: r.name, role: r.role }));
}

export interface Membership {
  role: MembershipRole;
  /** Permissions the org's settings grant on top of the role (an editor approving notices, CMP-24). */
  grants: string[];
}

export async function membershipFor(db: Executor, userId: string, orgId: string): Promise<Membership | null> {
  const { rows } = await db.execute<{ role: MembershipRole; grants: string[] }>(sql`select role, grants from membership_for(${userId}::uuid, ${orgId}::uuid)`);
  return rows[0] ? { role: rows[0].role, grants: rows[0].grants } : null;
}

export async function orgsDueFor(db: Executor, job: OrgSpanningJob): Promise<string[]> {
  const { rows } = await db.execute<{ org_id: string }>(sql`select org_id from orgs_due_for(${job}) as org_id`);
  return rows.map((r) => r.org_id);
}

export async function resolveJobOrg(db: Executor, type: JobResourceType, id: string): Promise<string | null> {
  const { rows } = await db.execute<{ org_id: string | null }>(sql`select resolve_job_org(${type}, ${id}::uuid) as org_id`);
  return rows[0]?.org_id ?? null;
}

export interface ResolvedFormSlug {
  orgId: string;
  formId: string;
  liveVersionId: string;
  /** The form's current address; differs from the requested slug when that one is an old slug (redirect to this). */
  primarySlug: string;
}

/**
 * The live form behind a public slug, current or old (migration 0020: through `form_slugs`). Null for an unknown slug and
 * for a form that is archived, trashed or not published.
 */
export async function resolveFormSlug(db: Executor, slug: string): Promise<ResolvedFormSlug | null> {
  const { rows } = await db.execute<{ org_id: string; form_id: string; live_version_id: string; primary_slug: string }>(
    sql`select org_id, form_id, live_version_id, primary_slug from resolve_form_slug(${slug})`,
  );
  const row = rows[0];
  return row ? { orgId: row.org_id, formId: row.form_id, liveVersionId: row.live_version_id, primarySlug: row.primary_slug } : null;
}

/**
 * The argon2id hash of a form's password, for the unlock route only (migration 0020). `form_access.password_hash` is not
 * selectable by fr_app. Answers inside a tenant context of a respondent or system actor, for a form of that context's
 * org; null for a form with no password, a form of another org, no tenant context, or any other actor kind.
 */
export async function formAccessPasswordHash(db: Executor, formId: string): Promise<string | null> {
  const { rows } = await db.execute<{ hash: string | null }>(sql`select form_access_password_hash(${formId}::uuid) as hash`);
  return rows[0]?.hash ?? null;
}

export async function createPartitions(db: Executor, parent: PartitionedTable, months: number): Promise<string[]> {
  const { rows } = await db.execute<{ name: string }>(sql`select name from create_partitions(${`public.${parent}`}::regclass, ${months}) as name`);
  return rows.map((r) => r.name);
}

/** What the upload route recorded about a file (migration 0019, `form_files_check`): never the bytes, the owner or the log. */
export interface CheckedFile {
  id: string;
  blockId: string;
  purpose: 'file' | 'signature';
  name: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * The files named by `ids` that were uploaded to this form, inside a tenant context (the org is the context's). The
 * respondent routes use this instead of reading `form_files`, which a respondent cannot read at all. At most 100 ids.
 */
export async function formFilesCheck(db: Executor, formId: string, ids: readonly string[]): Promise<CheckedFile[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.execute<{ id: string; block_id: string; purpose: 'file' | 'signature'; name: string; mime: string; size_bytes: number; sha256: string }>(
    sql`select id, block_id, purpose, name, mime, size_bytes, sha256 from form_files_check(${formId}::uuid, ${pgArray(ids)}::uuid[])`,
  );
  return rows.map((r) => ({ id: r.id, blockId: r.block_id, purpose: r.purpose, name: r.name, mime: r.mime, sizeBytes: r.size_bytes, sha256: r.sha256 }));
}
