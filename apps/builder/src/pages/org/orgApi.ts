import { z } from 'zod';

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
