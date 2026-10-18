import type { MembershipRole } from '@form/db';

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

/** `compliance.approve_notice` is grantable to editors per org (CMP-24); it is not a default. */
export const ROLE_PERMISSIONS: Record<MembershipRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter((p) => p !== 'billing.manage'),
  editor: [...FORMS_AUTHOR, ...DATA_WRITE],
  creator: FORMS_AUTHOR,
  data_collaborator: ['forms.read', ...DATA_WRITE],
  data_viewer: ['forms.read', 'submissions.read'],
  viewer: ['forms.read', 'submissions.read'],
};
