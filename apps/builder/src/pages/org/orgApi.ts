import { z } from 'zod';
import { orgApi } from '@/auth/client';

/** The org endpoints' answers (WP-1.02), as the builder reads them. */

export const ORG_ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const orgSchema = z.object({
  org: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    locale: z.string(),
    timeZone: z.string(),
    dateFormat: z.string(),
  }),
  role: z.string(),
  permissions: z.array(z.string()),
});
export type OrgInfo = z.infer<typeof orgSchema>;

export const membersSchema = z.object({
  items: z.array(z.object({ userId: z.string(), email: z.string(), name: z.string().nullable(), role: z.string(), status: z.string(), joinedAt: z.string() })),
  accessLinks: z.boolean(),
});
export type Members = z.infer<typeof membersSchema>;
export type MemberRow = Members['items'][number];

export const inviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  state: z.enum(['open', 'expired']),
});
export type InviteRow = z.infer<typeof inviteSchema>;

export const invitesSchema = z.object({ items: z.array(inviteSchema) });
export const invitedSchema = z.object({ invite: inviteSchema, link: z.string(), emailed: z.boolean() });
export const accessLinkSchema = z.object({ link: z.string(), purpose: z.string(), expiresAt: z.string() });
export const settingsSchema = z.object({ editorsApproveNotice: z.boolean(), inviteDays: z.number() });
export type OrgSettings = z.infer<typeof settingsSchema>;

/** Mirrors the API (`canManage`): owners manage everyone; admins everyone but owners, and cannot make owners. */
export function canManage(actor: string, target: string, to?: string): boolean {
  if (actor === 'owner') return true;
  if (actor !== 'admin') return false;
  return target !== 'owner' && to !== 'owner';
}

/** The roles `actor` may give. */
export const assignable = (actor: string): OrgRole[] => ORG_ROLES.filter((r) => canManage(actor, 'viewer', r));

/*
 * Review groups (WP-2.33): named sets of checkers that a form's review units are given to. Managing them needs
 * `members.manage`; the same list is read by a form's Review tab to offer a group per unit.
 */

export const reviewGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  /** Null for a group in use. An archived group keeps its members and its past decisions, and takes no new units or members. */
  archivedAt: z.string().nullable(),
  members: z.array(
    z.object({
      userId: z.string(),
      email: z.string(),
      name: z.string().nullable(),
      role: z.string(),
      /** False when the member's role no longer carries `submissions.review`, or they are suspended: still listed, and decide nothing. */
      canReview: z.boolean(),
      addedAt: z.string(),
    }),
  ),
});
export type ReviewGroup = z.infer<typeof reviewGroupSchema>;
export const reviewGroupsSchema = z.object({ items: z.array(reviewGroupSchema) });

/** The roles that carry `submissions.review` (owner, admin, editor): the API refuses anyone else as a checker (422 `NOT_A_REVIEWER`). Used only to offer the likely choices. */
export const REVIEWER_ROLES: readonly string[] = ['owner', 'admin', 'editor'];

const groupUrl = (id: string) => `/v1/org/review-groups/${encodeURIComponent(id)}`;

/** The org's review groups; `includeArchived` adds the archived ones (the Members page lists them so they can be brought back). */
export async function listReviewGroups(o: { includeArchived?: boolean } = {}): Promise<ReviewGroup[]> {
  return (await orgApi('GET', `/v1/org/review-groups${o.includeArchived ? '?includeArchived=true' : ''}`, reviewGroupsSchema)).items;
}

export const createReviewGroup = (name: string): Promise<ReviewGroup> => orgApi('POST', '/v1/org/review-groups', reviewGroupSchema, { name });

export const updateReviewGroup = (id: string, change: { name?: string; archived?: boolean }): Promise<ReviewGroup> =>
  orgApi('PATCH', groupUrl(id), reviewGroupSchema, change);

export const addReviewGroupMember = (id: string, userId: string): Promise<ReviewGroup> =>
  orgApi('PUT', `${groupUrl(id)}/members/${encodeURIComponent(userId)}`, reviewGroupSchema);

export const removeReviewGroupMember = (id: string, userId: string): Promise<void> =>
  orgApi('DELETE', `${groupUrl(id)}/members/${encodeURIComponent(userId)}`, null);
