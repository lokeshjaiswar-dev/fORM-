import { defineMessages, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import type { DeliveryStatus, WebhookEvent } from '@/persistence/webhooksApi';

/*
 * The words the two webhook panels share: what each event and delivery status is called, the sentence for a member whose
 * role has no `data.route`, how a failed call reads, and where the signature recipe is. They are declared once so the
 * Webhooks tab and its delivery log say the same thing.
 */

export const W = defineMessages('builder', {
  'webhooks.event.submission_created': 'A response is submitted',
  'webhooks.event.submission_updated': 'A response is edited',
  'webhooks.event.submission_deleted': 'A response is deleted',
  'webhooks.event.payment_succeeded': 'A payment succeeds',
  'webhooks.event.consent_withdrawn': 'Consent is withdrawn',
  'webhooks.status.pending': 'Waiting',
  'webhooks.status.retrying': 'Retrying',
  'webhooks.status.succeeded': 'Delivered',
  'webhooks.status.failed': 'Failed',
  'webhooks.status.dead': 'Gave up',
  'webhooks.no_permission.title': 'You need the data routing permission',
  'webhooks.no_permission.body': 'Webhooks send responses to outside addresses, so only roles with the data routing permission can see or change them. Ask an owner or admin of this organisation to give you that, or to set the webhook up for you.',
  'webhooks.error.unreachable': 'The server cannot be reached. Check your connection and try again.',
  'webhooks.error.not_found': 'That webhook is no longer on this form.',
  'webhooks.error.unavailable': 'This server cannot do that yet. Try again later.',
  'webhooks.error.generic': 'Something went wrong. Try again.',
  'webhooks.signature_doc': 'How to check a webhook’s signature',
});

/** Where the recipe that verifies a signature is published (`docs/platform/webhook-signatures.md`). A deployment that hosts its own docs sets `VITE_WEBHOOK_DOCS_URL`. */
export const WEBHOOK_SIGNATURE_DOC_URL: string =
  (import.meta.env.VITE_WEBHOOK_DOCS_URL as string | undefined) || 'https://github.com/lokeshjaiswar-dev/fORM-/blob/main/docs/platform/webhook-signatures.md';

export const EVENT_LABELS: Readonly<Record<WebhookEvent, MessageId>> = {
  'submission.created': W['webhooks.event.submission_created'],
  'submission.updated': W['webhooks.event.submission_updated'],
  'submission.deleted': W['webhooks.event.submission_deleted'],
  'payment.succeeded': W['webhooks.event.payment_succeeded'],
  'consent.withdrawn': W['webhooks.event.consent_withdrawn'],
};

export const STATUS_LABELS: Readonly<Record<DeliveryStatus, MessageId>> = {
  pending: W['webhooks.status.pending'],
  retrying: W['webhooks.status.retrying'],
  succeeded: W['webhooks.status.succeeded'],
  failed: W['webhooks.status.failed'],
  dead: W['webhooks.status.dead'],
};

/** A refusal for want of `data.route`: the API answers every webhook route with a 403 for a role that lacks it. */
export const isForbidden = (err: unknown): boolean => err instanceof ApiProblem && err.status === 403;

/**
 * What to tell the member about a failed call that has no field of its own to sit next to: an unreachable server says so,
 * a missing webhook says so, a server that lacks the pieces to do it says so, and anything else says `fallback`, the
 * sentence for the action that failed.
 */
export function describeWebhookFailure(err: unknown, fallback: MessageId = W['webhooks.error.generic']): string {
  if (err instanceof ApiUnreachable) return t(W['webhooks.error.unreachable']);
  if (err instanceof ApiProblem) {
    if (err.status === 404) return t(W['webhooks.error.not_found']);
    if (err.status === 503) return t(W['webhooks.error.unavailable']);
  }
  return t(fallback);
}
