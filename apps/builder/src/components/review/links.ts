/**
 * The address names a response to open (`?response=<id>`): the review queue links to a form's Responses page with it, and the
 * page opens that response even when its row is not among the rows loaded yet, since the pane needs only its id.
 */
export const OPEN_PARAM = 'response';

/** Where a review queue row leads: the response open on its form's Responses page, where the member reads it and decides. */
export const responseLink = (item: { formId: string; submissionId: string }): string =>
  `/forms/${encodeURIComponent(item.formId)}/responses?${OPEN_PARAM}=${encodeURIComponent(item.submissionId)}`;
