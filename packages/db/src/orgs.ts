import { sql } from 'drizzle-orm';
import type { Executor, Tx } from './client.ts';
import type { AuthTokenPurpose, OrgRole } from './schema/index.ts';

/** Typed calls of the org, invite and member definer functions (migration 0008, WP-1.02). */

export type CreateOrgOutcome = 'created' | 'slug_taken' | 'limit';

export interface NewOrg {
  id: string;
  slug: string;
  name: string;
  userId: string;
  locale?: string | undefined;
  timeZone?: string | undefined;
  dateFormat?: string | undefined;
}

/** Inside the caller's own user context (`withUser`, or `withTenant` of the new org with the same user). */
export async function createOrg(tx: Tx, o: NewOrg): Promise<CreateOrgOutcome> {
  const { rows } = await tx.execute<{ outcome: CreateOrgOutcome }>(
    sql`select create_org(${o.id}::uuid, ${o.slug}, ${o.name}, ${o.userId}::uuid, ${o.locale ?? null}, ${o.timeZone ?? null}, ${o.dateFormat ?? null}) as outcome`,
  );
  return rows[0]!.outcome;
}

export type InviteState = 'open' | 'used' | 'revoked' | 'expired' | 'org_inactive';

export interface InviteInfo {
  inviteId: string;
  orgId: string;
  orgName: string;
  email: string;
  role: OrgRole;
  inviterName: string;
  state: InviteState;
  expiresAt: Date;
}

/** Who an invite link is for, without using it; null for an unknown token. */
export async function inviteByToken(db: Executor, tokenHash: Uint8Array): Promise<InviteInfo | null> {
  const { rows } = await db.execute<{
    invite_id: string;
    org_id: string;
    org_name: string;
    email: string;
    role: OrgRole;
    inviter_name: string;
    state: InviteState;
    expires_at: string | Date;
  }>(sql`select * from invite_by_token(${Buffer.from(tokenHash)})`);
  const r = rows[0];
  return r
    ? { inviteId: r.invite_id, orgId: r.org_id, orgName: r.org_name, email: r.email, role: r.role, inviterName: r.inviter_name, state: r.state, expiresAt: new Date(r.expires_at) }
    : null;
}

export type InviteAcceptOutcome =
  | 'accepted'
  | 'already_member'
  | 'unknown'
  | 'revoked'
  | 'used'
  | 'expired'
  | 'org_inactive'
  | 'email_not_verified'
  | 'email_mismatch'
  | 'suspended';

export interface InviteAcceptResult {
  outcome: InviteAcceptOutcome;
  inviteId: string | null;
  orgId: string | null;
  role: OrgRole | null;
}

/** Inside the accepting user's context (`withUser`): the function checks it is that user. */
export async function inviteAccept(tx: Tx, tokenHash: Uint8Array, userId: string): Promise<InviteAcceptResult> {
  const { rows } = await tx.execute<{ outcome: InviteAcceptOutcome; invite_id: string | null; org_id: string | null; role: OrgRole | null }>(
    sql`select * from invite_accept(${Buffer.from(tokenHash)}, ${userId}::uuid)`,
  );
  const r = rows[0]!;
  return { outcome: r.outcome, inviteId: r.invite_id, orgId: r.org_id, role: r.role };
}

/** Inside a tenant context with `members.manage`: revokes the member's sessions bound to that org; returns how many. */
export async function memberSessionsRevoke(tx: Tx, userId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`select member_sessions_revoke(${userId}::uuid) as n`);
  return rows[0]!.n;
}

export type MemberAccessOutcome = 'issued' | 'not_a_member' | 'other_orgs' | 'forbidden' | 'inactive';

/** BL-203, inside a tenant context with `members.manage`: a one-time reset (or verification) token for a member. */
export async function memberAccessToken(
  tx: Tx,
  o: { userId: string; tokenId: string; tokenHash: Uint8Array; minutes: number },
): Promise<{ outcome: MemberAccessOutcome; purpose: Extract<AuthTokenPurpose, 'password_reset' | 'verify_email'> | null }> {
  const { rows } = await tx.execute<{ outcome: MemberAccessOutcome; purpose: 'password_reset' | 'verify_email' | null }>(
    sql`select * from member_access_token(${o.userId}::uuid, ${o.tokenId}::uuid, ${Buffer.from(o.tokenHash)}, ${o.minutes})`,
  );
  return { outcome: rows[0]!.outcome, purpose: rows[0]!.purpose };
}
