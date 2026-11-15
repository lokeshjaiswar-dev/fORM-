import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_EVENTS, CORE_AUDIT_EVENTS, type AuditAction } from '../catalogue.ts';
import { ACCESS_EVENTS } from './access.ts';
import { FORMS_EVENTS } from './forms.ts';
import { PUBLISH_EVENTS } from './publish.ts';
import { SUBMISSIONS_EVENTS } from './submissions.ts';

const FILES = { core: CORE_AUDIT_EVENTS, forms: FORMS_EVENTS, publish: PUBLISH_EVENTS, access: ACCESS_EVENTS, submissions: SUBMISSIONS_EVENTS } as const;

/**
 * The catalogue spreads one object per domain. A spread lets the later object silently replace an earlier code, so two
 * work packages that both list `form.published` would not fail anywhere: one description would just vanish.
 */
describe('audit event files', () => {
  it('keep AuditAction a closed union of the codes, which `tsc` checks (a spread must not widen it to string)', () => {
    const listed: AuditAction = 'request.authorize';
    // @ts-expect-error a code that no file lists is not an AuditAction
    const unlisted: AuditAction = 'no.such_code';
    expect([listed, unlisted]).toHaveLength(2);
  });

  it('list no code twice', () => {
    const owners = new Map<string, string[]>();
    for (const [file, events] of Object.entries(FILES)) {
      for (const code of Object.keys(events)) owners.set(code, [...(owners.get(code) ?? []), file]);
    }
    expect([...owners].filter(([, files]) => files.length > 1)).toEqual([]);
  });

  it('add up to the catalogue, each code once', () => {
    const total = Object.values(FILES).map((events) => Object.keys(events).length).reduce((a, b) => a + b, 0);
    expect(AUDIT_ACTIONS).toHaveLength(total);
    expect(new Set(AUDIT_ACTIONS).size).toBe(total);
  });

  it('keep each domain’s spec as listed', () => {
    for (const events of Object.values(FILES)) {
      for (const [code, spec] of Object.entries(events)) expect(AUDIT_EVENTS[code as keyof typeof AUDIT_EVENTS]).toBe(spec);
    }
  });
});
