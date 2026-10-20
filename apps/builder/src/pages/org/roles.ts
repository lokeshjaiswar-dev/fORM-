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
