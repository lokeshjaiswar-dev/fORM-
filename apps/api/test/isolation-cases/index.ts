import { ACCESS_ISOLATION } from './access.ts';
import { CORE_ISOLATION } from './core.ts';
import { FORMS_ISOLATION } from './forms.ts';
import { PUBLISH_ISOLATION } from './publish.ts';
import { SUBMISSIONS_ISOLATION } from './submissions.ts';
import type { IsolationCase, IsolationDomain } from './types.ts';

export { seedCore } from './core.ts';
export { collect, coverage, type CollectedRoute } from './guard.ts';
export type * from './types.ts';

/** One file per domain, so work packages that add routes in parallel edit different files. */
export const ISOLATION_DOMAINS: Record<string, IsolationDomain> = {
  core: CORE_ISOLATION,
  forms: FORMS_ISOLATION,
  publish: PUBLISH_ISOLATION,
  access: ACCESS_ISOLATION,
  submissions: SUBMISSIONS_ISOLATION,
};

export const ISOLATION_CASES: IsolationCase[] = Object.values(ISOLATION_DOMAINS).flatMap((d) => d.cases);

export const ISOLATION_SEEDS = Object.values(ISOLATION_DOMAINS).flatMap((d) => (d.seed ? [d.seed] : []));
