import { describe, expect, it } from 'vitest';
import { MAX_ISSUES, capIssues, distinctIssues, type PipelineIssue } from './issues.ts';

const issue = (code: PipelineIssue['code'], path: string, severity: PipelineIssue['severity'] = 'error', message: string = code): PipelineIssue => ({ severity, code, path, message });

describe('distinctIssues', () => {
  it('drops an issue found twice (the checks overlap) and puts errors before warnings, each in the order found', () => {
    const issues = [
      issue('missing_alt_text', '/blocks/a', 'warning'),
      issue('logic_cycle', '/logic/rules/0'),
      issue('logic_cycle', '/logic/rules/0'),
      issue('unsafe_regex', '/blocks/b/config/pattern/source'),
      issue('initially_hidden_never_shown', '/pages/1', 'warning'),
    ];
    expect(distinctIssues(issues).map((i) => `${i.severity}:${i.code}`)).toEqual([
      'error:logic_cycle',
      'error:unsafe_regex',
      'warning:missing_alt_text',
      'warning:initially_hidden_never_shown',
    ]);
  });

  it('keeps two issues of one code at one path when their messages differ', () => {
    expect(distinctIssues([issue('duplicate_id', '/blocks/a', 'error', 'one'), issue('duplicate_id', '/blocks/a', 'error', 'two')])).toHaveLength(2);
  });
});

describe('capIssues', () => {
  it('keeps the first MAX_ISSUES and reports the real count', () => {
    const many = Array.from({ length: MAX_ISSUES + 25 }, (_v, i) => issue('unsafe_regex', `/blocks/f${i}`));
    const { issues, issueCount } = capIssues(many);
    expect(issues).toHaveLength(MAX_ISSUES);
    expect(issues[0]!.path).toBe('/blocks/f0');
    expect(issueCount).toBe(MAX_ISSUES + 25);
    expect(capIssues(many.slice(0, 3))).toEqual({ issues: many.slice(0, 3), issueCount: 3 });
  });
});
