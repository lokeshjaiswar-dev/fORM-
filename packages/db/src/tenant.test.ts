import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertTenantCtx, isUuid, pgArray } from './tenant.ts';

describe('pgArray', () => {
  it('builds quoted array literals', () => {
    expect(pgArray([])).toBe('{}');
    expect(pgArray(['forms.read', 'submissions.read'])).toBe('{"forms.read","submissions.read"}');
    expect(pgArray(['a"b', 'c\\d', 'e,f}'])).toBe('{"a\\"b","c\\\\d","e,f}"}');
  });
});

describe('isUuid', () => {
  it('accepts uuids only', () => {
    expect(isUuid(randomUUID())).toBe(true);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});

describe('assertTenantCtx', () => {
  const ok = { orgId: randomUUID(), actor: 'system' as const, requestId: 'r' };

  it('accepts actors without a user id', () => {
    for (const actor of ['api_key', 'system', 'respondent', 'platform'] as const) expect(() => assertTenantCtx({ ...ok, actor })).not.toThrow();
  });

  it('accepts respondent subject ids and wildcard permission names', () => {
    expect(() => assertTenantCtx({ ...ok, actor: 'respondent', subjectIds: [randomUUID()] })).not.toThrow();
    expect(() => assertTenantCtx({ ...ok, perms: ['templates.*', 'forms.create'] })).not.toThrow();
  });

  it('rejects a missing request id or an overlong one', () => {
    expect(() => assertTenantCtx({ ...ok, requestId: 'x'.repeat(129) })).toThrow(/requestId/);
  });
});
