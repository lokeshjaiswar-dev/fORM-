import { sql } from 'drizzle-orm';
import type { Executor } from './client.ts';
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

export const PARTITIONED_TABLES = ['audit_log'] as const;
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

export async function createPartitions(db: Executor, parent: PartitionedTable, months: number): Promise<string[]> {
  const { rows } = await db.execute<{ name: string }>(sql`select name from create_partitions(${`public.${parent}`}::regclass, ${months}) as name`);
  return rows.map((r) => r.name);
}
