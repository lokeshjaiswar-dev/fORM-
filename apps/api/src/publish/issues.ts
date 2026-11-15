import type { PublishIssue } from '@form/schema';

/**
 * A reason a draft cannot be published, or a warning about it. The schema's `PublishIssue` plus the two codes only the
 * API produces: `invalid_definition` (the saved draft is not a v2 form at all: the strict parse failed) and
 * `redirect_not_allowed` (an address is not on the form's redirect allowlist).
 */
export interface PipelineIssue {
  severity: PublishIssue['severity'];
  code: PublishIssue['code'] | 'invalid_definition' | 'redirect_not_allowed';
  /** JSON pointer into the definition. */
  path: string;
  message: string;
  fixUrl?: string;
}

/** How many issues one answer carries. A 5 MB draft can hold thousands; the author fixes the first ones and asks again. */
export const MAX_ISSUES = 200;

const key = (issue: PipelineIssue) => `${issue.code}\u0000${issue.path}\u0000${issue.message}`;

/** The issues without repeats, errors first (the order within each severity is the order they were found in). */
export function distinctIssues(issues: readonly PipelineIssue[]): PipelineIssue[] {
  const seen = new Set<string>();
  const unique = issues.filter((issue) => {
    const k = key(issue);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return [...unique.filter((i) => i.severity === 'error'), ...unique.filter((i) => i.severity !== 'error')];
}

/** The first `MAX_ISSUES` of `issues` and how many there were. */
export function capIssues(issues: readonly PipelineIssue[]): { issues: PipelineIssue[]; issueCount: number } {
  return { issues: issues.slice(0, MAX_ISSUES), issueCount: issues.length };
}
