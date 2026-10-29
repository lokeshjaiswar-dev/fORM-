import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ANSWER_KEYS as PLUGIN_KEYS } from '../../../../tools/lint/audit-plugin.js';
import { ANSWER_KEYS } from './scrub.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const plugin = path.join(root, 'tools/lint/audit-plugin.js');
const oxlint = path.join(root, 'node_modules/oxlint/bin/oxlint');
const dir = mkdtempSync(path.join(tmpdir(), 'fr-audit-lint-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(path.join(dir, '.oxlintrc.json'), JSON.stringify({ jsPlugins: [plugin], rules: { 'form-audit/no-answer-values': 'error' } }));

/** The messages oxlint reports for `source`. */
function lint(source: string): string[] {
  const file = path.join(dir, `case-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, `declare const audit: any, tx: any, org: any, ctx: any, auditActor: any, row: any, event: any;\n${source}\n`);
  const r = spawnSync(process.execPath, [oxlint, '-c', path.join(dir, '.oxlintrc.json'), '--format', 'unix', file], { encoding: 'utf8' });
  return r.stdout
    .split('\n')
    .filter((l) => l.includes('form-audit'))
    .map((l) => l.replace(/^.*?:\d+:\d+: /, '').replace(/ \[\w+\/form-audit\(no-answer-values\)\]$/, '').trim());
}

describe('form-audit/no-answer-values', () => {
  it('uses the same answer keys as the runtime scrubber', () => {
    expect(PLUGIN_KEYS).toEqual([...ANSWER_KEYS]);
  });

  it('accepts literal actions with ids and counts in metadata', () => {
    expect(
      lint(`audit.append(tx, org, { ...auditActor(ctx), action: 'submission.page_viewed', resourceType: 'form', outcome: 'success', metadata: { ids: row.ids, count: row.ids.length, page: 1 } });
audit.appendDetached(tx, null, { actorKind: 'none', action: 'request.authorize', resourceType: 'route', outcome: 'denied' });
other.append(tx, org, event);`),
    ).toEqual([]);
  });

  it('flags answer keys, answer-named values, spreads and non-literal events or actions', { timeout: 30_000 }, () => {
    const out = lint(`audit.append(tx, org, { action: 'x', resourceType: 'f', outcome: 'success', metadata: { answers: row.answers } });
audit.append(tx, org, { action: 'x', resourceType: 'f', outcome: 'success', metadata: { email: row.values.email } });
audit.append(tx, org, { action: 'x', resourceType: 'f', outcome: 'success', metadata: { ...row } });
audit.append(tx, org, { action: 'x', resourceType: 'f', outcome: 'success', metadata: row });
audit.append(tx, org, { action: 'x', resourceType: 'f', outcome: 'success', metadata: { nested: { submission_data: 1 } } });
audit.append(tx, org, event);
audit.appendDetached(tx, org, { ...event, action: 'x' });
audit.append(tx, org, { action: row.action, resourceType: 'f', outcome: 'success' });`);
    expect(out).toEqual([
      'Audit metadata key `answers` names answer values.',
      '`values` looks like answer values; audit metadata carries ids and counts only.',
      'No spreads in audit metadata: list the fields.',
      'Audit `metadata` must be an object literal.',
      'Audit metadata key `submission_data` names answer values.',
      'Pass the audit event as an object literal, so the call site can be checked.',
      'No spreads in an audit event except `...auditActor(ctx)`.',
      'Audit `action` must be a string literal from AUDIT_EVENTS.',
    ]);
  });
});
