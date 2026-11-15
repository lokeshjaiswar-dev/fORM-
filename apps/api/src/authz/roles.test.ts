import { describe, expect, it } from 'vitest';
import { MEMBERSHIP_ROLES } from '@form/db';
import { PERMISSIONS, permissionsFor, ROLE_PERMISSIONS } from './roles.ts';

describe('submissions.review (WP-2.33)', () => {
  it('is a permission, and owner, admin and editor carry it', () => {
    expect(PERMISSIONS).toContain('submissions.review');
    for (const role of ['owner', 'admin', 'editor'] as const) expect(permissionsFor(role), role).toContain('submissions.review');
  });

  it('is not carried by creator, data_collaborator, data_viewer or viewer in this slice', () => {
    for (const role of ['creator', 'data_collaborator', 'data_viewer', 'viewer'] as const) expect(permissionsFor(role), role).not.toContain('submissions.review');
  });

  it('cannot be granted on top of a role by the org settings (the grants only carry compliance.approve_notice for editors)', () => {
    expect(permissionsFor('viewer', ['submissions.review'])).not.toContain('submissions.review');
    expect(permissionsFor('creator', ['submissions.review'])).not.toContain('submissions.review');
    expect(permissionsFor('data_collaborator', ['submissions.review'])).not.toContain('submissions.review');
  });

  it('is exactly the set of roles the builder offers for review groups (apps/builder/src/pages/org/roles.ts, REVIEWER_ROLES)', () => {
    const reviewers = MEMBERSHIP_ROLES.filter((role) => ROLE_PERMISSIONS[role].includes('submissions.review'));
    expect([...reviewers].sort()).toEqual(['admin', 'editor', 'owner']);
  });

  it('leaves every other permission of the roles as it was', () => {
    expect(ROLE_PERMISSIONS.viewer).toEqual(['forms.read', 'submissions.read']);
    expect(ROLE_PERMISSIONS.data_viewer).toEqual(['forms.read', 'submissions.read']);
    expect(ROLE_PERMISSIONS.editor).not.toContain('members.manage');
    expect(ROLE_PERMISSIONS.admin).not.toContain('billing.manage');
  });
});
