import { sql } from 'drizzle-orm';
import type { Tx } from './client.ts';
import type { MembershipRole } from './schema/index.ts';

/**
 * Typed calls of the account definer functions (migration 0007, CMP-21). Both run only inside `withUser` for the
 * user themselves: the functions refuse any other context.
 */

export interface ExportedMembership {
  orgId: string;
  orgSlug: string;
  orgName: string;
  role: MembershipRole;
  status: string;
  joinedAt: string;
  formsOwned: number;
}

export interface ExportedActivity {
  occurredAt: string;
  action: string;
  outcome: string;
  reason: string | null;
  resourceType: string;
  resourceId: string | null;
  sessionId: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

export interface AccountExportData {
  memberships: ExportedMembership[];
  /** The user's own events on the platform audit chain, newest first, at most 5000 from the last 13 months. */
  activity: ExportedActivity[];
}

/** What the user's own context cannot read: memberships and the user's platform audit events. */
export async function accountExportData(tx: Tx, userId: string): Promise<AccountExportData> {
  const { rows } = await tx.execute<{ data: AccountExportData }>(sql`select account_export_data(${userId}::uuid) as data`);
  return rows[0]!.data;
}

/** Why an org stops a deletion: nobody would be left to manage it, it would have no owner, or nobody could take the forms. */
export const DELETION_BLOCKERS = ['last_member', 'sole_owner', 'no_owner_for_forms'] as const;
export type DeletionBlocker = (typeof DELETION_BLOCKERS)[number];

export interface DeletionOrg {
  orgId: string;
  slug: string;
  name: string;
  role: MembershipRole;
  formsOwned: number;
  /** The owner the user's forms pass to. */
  formsTo: string | null;
  blocker: DeletionBlocker | null;
}

export type AccountDeletion =
  | { status: 'blocked' | 'ready'; orgs: DeletionOrg[] }
  | { status: 'deleted'; orgs: DeletionOrg[]; orgsLeft: number; formsReassigned: number; sessionsEnded: number };

/**
 * The deletion plan (`apply: false`), or the deletion itself: refused (`blocked`, nothing changed) while an org would
 * be left without an owner or members; otherwise the account becomes a pseudonymous tombstone in this transaction.
 */
export async function accountDelete(tx: Tx, userId: string, o: { apply: boolean }): Promise<AccountDeletion> {
  const { rows } = await tx.execute<{ result: AccountDeletion }>(sql`select account_delete(${userId}::uuid, ${o.apply}) as result`);
  return rows[0]!.result;
}
