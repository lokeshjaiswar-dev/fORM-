import { describe, expect, it } from 'vitest';
import { ORG_DATE_FORMATS, ORG_ROLES } from '@form/db';
import { SUPPORTED_DATE_PATTERNS } from '@form/i18n';
import { canManage, permissionsFor, ROLE_PERMISSIONS } from '../../authz/roles.ts';
import { localeSchema, orgNameSchema, slugFrom, slugSchema, SLUG, timeZoneSchema, withSuffix } from './schemas.ts';

describe('roles and permissions (WSP-03)', () => {
  it('maps P1 roles to their permission sets, with data.route and notice approval where the matrix says', () => {
    expect(ROLE_PERMISSIONS.owner).toEqual(expect.arrayContaining(['billing.manage', 'members.manage', 'data.route', 'compliance.approve_notice']));
    expect(ROLE_PERMISSIONS.admin).not.toContain('billing.manage');
    expect(ROLE_PERMISSIONS.admin).toEqual(expect.arrayContaining(['members.manage', 'org.settings', 'data.route', 'compliance.approve_notice']));
    expect(ROLE_PERMISSIONS.editor).toEqual(expect.arrayContaining(['forms.edit', 'data.route']));
    expect(ROLE_PERMISSIONS.editor).not.toContain('compliance.approve_notice');
    expect(ROLE_PERMISSIONS.editor).not.toContain('members.manage');
    expect([...ROLE_PERMISSIONS.viewer].sort()).toEqual(['forms.read', 'submissions.read']);
    expect(ROLE_PERMISSIONS.creator).not.toContain('data.route');
  });

  it('adds only grants an org may give to that role', () => {
    expect(permissionsFor('editor', ['compliance.approve_notice'])).toContain('compliance.approve_notice');
    expect(permissionsFor('viewer', ['compliance.approve_notice', 'members.manage'])).toEqual([...ROLE_PERMISSIONS.viewer]);
    expect(permissionsFor('editor', ['members.manage'])).not.toContain('members.manage');
    expect(permissionsFor('owner', ['compliance.approve_notice'])).toEqual([...ROLE_PERMISSIONS.owner]);
  });

  it('lets owners manage everyone and admins everyone but owners', () => {
    for (const target of ORG_ROLES) for (const to of ORG_ROLES) expect(canManage('owner', target, to)).toBe(true);
    expect(canManage('admin', 'editor', 'admin')).toBe(true);
    expect(canManage('admin', 'admin')).toBe(true);
    expect(canManage('admin', 'owner')).toBe(false);
    expect(canManage('admin', 'viewer', 'owner')).toBe(false);
    expect(canManage('editor', 'viewer', 'viewer')).toBe(false);
    expect(canManage('viewer', 'viewer')).toBe(false);
  });
});

describe('org fields (WSP-09)', () => {
  it('offers the date formats @form/i18n can render', () => {
    expect([...ORG_DATE_FORMATS]).toEqual([...SUPPORTED_DATE_PATTERNS]);
  });

  it('makes slugs from names', () => {
    expect(slugFrom('Acme Pvt. Ltd.')).toBe('acme-pvt-ltd');
    expect(slugFrom('  Café Ñandú  ')).toBe('cafe-nandu');
    expect(slugFrom('संस्था')).toBe('org');
    expect(slugFrom('x'.repeat(80))).toHaveLength(48);
    for (const s of ['acme-pvt-ltd', slugFrom('-a-'), withSuffix('x'.repeat(63)), withSuffix('org')]) expect(s, s).toMatch(SLUG);
    expect(slugSchema.safeParse('-acme').success).toBe(false);
    expect(slugSchema.safeParse('Acme').success).toBe(false);
  });

  it('canonicalises locales and checks time zones and names', () => {
    expect(localeSchema.parse('en-in')).toBe('en-IN');
    expect(localeSchema.parse('hi-IN')).toBe('hi-IN');
    expect(localeSchema.safeParse('not a locale').success).toBe(false);
    expect(timeZoneSchema.safeParse('Asia/Kolkata').success).toBe(true);
    expect(timeZoneSchema.safeParse('UTC').success).toBe(true);
    expect(timeZoneSchema.safeParse('Mars/Olympus').success).toBe(false);
    expect(orgNameSchema.parse('  Acme  ')).toBe('Acme');
    expect(orgNameSchema.safeParse('a\u0000b').success).toBe(false);
    expect(orgNameSchema.safeParse('   ').success).toBe(false);
  });
});
