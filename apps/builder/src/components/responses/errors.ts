import { defineMessages, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import { ApiProblem, ApiUnreachable } from '@/auth/client';

const M = defineMessages('builder', {
  'responses.error.unreachable': 'The server cannot be reached. Check your connection and try again.',
  'responses.error.forbidden': 'Your role in this organisation does not allow that.',
  'responses.error.not_found': 'That form or response is no longer here.',
  'responses.error.unavailable': 'This is not available right now. Try again in a moment.',
  'responses.error.not_trashed': 'Only responses in the trash can be deleted forever. Nothing was deleted.',
  'responses.error.held': 'A response under a hold cannot be deleted. Nothing was deleted.',
  'responses.error.generic': 'Something went wrong. Try again.',
});

/**
 * What to tell the member about a failed call, in the page's words: a refusal the API gave a reason for (their role, a
 * hold, a response that is not in the trash) says so, an unreachable server says that, and anything else says
 * `fallback`, the sentence for the action that failed (a general one when the caller has none). The server's own `detail`
 * is not shown: it is written for logs.
 */
export function describeFailure(err: unknown, fallback: MessageId = M['responses.error.generic']): string {
  if (err instanceof ApiUnreachable) return t(M['responses.error.unreachable']);
  if (err instanceof ApiProblem) {
    if (err.code === 'SUBMISSION_NOT_TRASHED') return t(M['responses.error.not_trashed']);
    if (err.code === 'SUBMISSION_HELD') return t(M['responses.error.held']);
    if (err.status === 403) return t(M['responses.error.forbidden']);
    if (err.status === 404) return t(M['responses.error.not_found']);
    if (err.status === 503) return t(M['responses.error.unavailable']);
  }
  return t(fallback);
}

/** True for the API's "this cursor is not for this query" refusal: the page starts again from its first page. */
export const isInvalidCursor = (err: unknown): boolean => err instanceof ApiProblem && err.code === 'INVALID_CURSOR';
