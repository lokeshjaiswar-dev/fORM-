import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the forms domain: CRUD, drafts, the forms list, trash and restore (WP-1.06). Spread into `PROBLEMS`
 * by `../errors.ts`, so a work package adds its codes to its own domain file and never edits the shared one (fewer merge
 * conflicts). The codes stay a closed enum: `ProblemCode` is the union of every key, and `problems.test.ts` fails when
 * two files list the same code.
 */
export const FORMS_PROBLEMS = {} as const satisfies Record<string, ProblemSpec>;
