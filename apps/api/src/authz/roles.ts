import type { MembershipRole, OrgRole } from '@form/db';

/** Permission names loaded into `app.perms` (architecture §2.4, permissions table). */
export const PERMISSIONS = [
  'forms.create',
  'forms.edit',
  'forms.publish',
  'forms.read',
  'submissions.read',
  'submissions.edit',
  'submissions.delete',
  'submissions.export',
  'ops.manage',
  'data.route',
  'compliance.approve_notice',
  'compliance.dsr',
  'compliance.retention',
  'compliance.legal_hold',
  'compliance.statutory_access',
  'members.manage',
  'org.settings',
  'billing.manage',
  'api_keys.manage',
  'brand_kits.manage',
  'org_profile.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const FORMS_AUTHOR: Permission[] = ['forms.create', 'forms.edit', 'forms.publish', 'forms.read', 'ops.manage'];
const DATA_WRITE: Permission[] = ['submissions.read', 'submissions.edit', 'submissions.delete', 'submissions.export', 'data.route'];

/** `compliance.approve_notice` is grantable to editors per org (CMP-24, `org_settings.editors_approve_notice`); it is not a default. */
export const ROLE_PERMISSIONS: Record<MembershipRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter((p) => p !== 'billing.manage'),
  editor: [...FORMS_AUTHOR, ...DATA_WRITE],
  creator: FORMS_AUTHOR,
  data_collaborator: ['forms.read', ...DATA_WRITE],
  data_viewer: ['forms.read', 'submissions.read'],
  viewer: ['forms.read', 'submissions.read'],
};

/** Permissions an org may grant on top of a role, by role. Anything else `membership_for()` returns is ignored. */
export const GRANTABLE: Partial<Record<MembershipRole, readonly Permission[]>> = {
  editor: ['compliance.approve_notice'],
};

/** The role's permissions plus the grants the org's settings add (as `membership_for()` returns them). */
export function permissionsFor(role: MembershipRole, grants: readonly string[] = []): Permission[] {
  const extra = (GRANTABLE[role] ?? []).filter((p) => grants.includes(p));
  return [...ROLE_PERMISSIONS[role], ...extra.filter((p) => !ROLE_PERMISSIONS[role].includes(p))];
}

const RANK: Record<MembershipRole, number> = { owner: 3, admin: 2, editor: 1, creator: 1, data_collaborator: 1, data_viewer: 0, viewer: 0 };

/**
 * Whether a member with `members.manage` in role `actor` may change a member in role `target` (to role `to`, when
 * given): owners manage everyone; admins manage admins, editors and viewers, but neither owners nor the owner role.
 */
export function canManage(actor: MembershipRole, target: MembershipRole, to?: OrgRole): boolean {
  if (actor === 'owner') return true;
  if (actor !== 'admin') return false;
  return RANK[target] < RANK.owner && (to === undefined || RANK[to] < RANK.owner);
}
