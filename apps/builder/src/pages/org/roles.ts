import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';

const ROLE_MESSAGES = defineMessages('builder', {
  'role.owner': 'Owner',
  'role.admin': 'Admin',
  'role.editor': 'Editor',
  'role.viewer': 'Viewer',
  'role.creator': 'Creator',
  'role.data_collaborator': 'Data collaborator',
  'role.data_viewer': 'Data viewer',
});

/** The role's name for people; an unknown role reads as Viewer, the least it could be. */
export const roleLabel = (role: string): string => t(ROLE_MESSAGES[`role.${role}` as keyof typeof ROLE_MESSAGES] ?? ROLE_MESSAGES['role.viewer']);

/**
 * The roles whose members may check responses (WP-2.33): owner, admin and editor carry `submissions.review` in the API
 * (`ROLE_PERMISSIONS`, apps/api/src/authz/roles.ts); creators have no data access and the data roles get the permission
 * in P2 (WP-2.29). The API decides, and refuses anyone else with 422 NOT_A_REVIEWER; this list only keeps the review
 * groups' member picker from offering people it would refuse.
 */
export const REVIEWER_ROLES: readonly string[] = ['owner', 'admin', 'editor'];

/** Whether a member in `role` can be added to a review group. */
export const canReview = (role: string): boolean => REVIEWER_ROLES.includes(role);
