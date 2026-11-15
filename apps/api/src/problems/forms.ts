import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the forms domain: CRUD, drafts, the forms list, trash and restore (WP-1.06). Spread into `PROBLEMS`
 * by `../errors.ts`, so a work package adds its codes to its own domain file and never edits the shared one (fewer merge
 * conflicts). The codes stay a closed enum: `ProblemCode` is the union of every key, and `problems.test.ts` fails when
 * two files list the same code.
 */
export const FORMS_PROBLEMS = {
  // A draft write must say which revision it was made from; without it a stale tab would silently overwrite a newer save.
  PRECONDITION_REQUIRED: { status: 428, title: 'Send If-Match with the draft revision you read' },
  // The body parsed as JSON but is not a form definition this server stores (an unknown key, a wrong type, another form's id).
  DRAFT_INVALID: { status: 422, title: 'The form definition is not valid' },
  // A v1 document that the lenient v1 reader cannot make a form of.
  IMPORT_INVALID: { status: 422, title: 'The v1 form could not be read' },
  // A list cursor that this API did not sign for this list (edited, left over from changed filters, or from another list).
  INVALID_CURSOR: { status: 400, title: 'The page cursor is not valid for this list' },
  // Archive, trash or restore on a form whose state does not allow it (for example, archiving a trashed form).
  FORM_STATE_CONFLICT: { status: 409, title: 'The form is not in a state that allows this' },
} as const satisfies Record<string, ProblemSpec>;
