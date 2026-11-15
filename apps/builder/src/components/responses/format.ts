import { defineMessages, type MessageId } from '@form/i18n';
import { BUILDER_LOCALE, t } from '@/i18n';

const M = defineMessages('builder', {
  'responses.status.complete': 'Complete',
  'responses.status.spam': 'Spam',
  'responses.status.pending_payment': 'Awaiting payment',
  'responses.status.payment_failed': 'Payment failed',
  'responses.status.pending_scan': 'Checking files',
  'responses.status.pending_guardian_consent': 'Awaiting guardian consent',
  'responses.status.archived': 'Archived',
  'responses.status.trashed': 'In trash',
  'responses.version': 'v{n}',
  'responses.version_unpublished': 'Unpublished',
  'responses.version_unknown': 'Unknown',
});

const dateTime = new Intl.DateTimeFormat(BUILDER_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });

/** A moment as the reader's page shows it; the text as it came when it is not a date. */
export function formatWhen(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : dateTime.format(at);
}

const sizeFormats = {
  byte: new Intl.NumberFormat(BUILDER_LOCALE, { style: 'unit', unit: 'byte', unitDisplay: 'narrow', maximumFractionDigits: 0 }),
  kilobyte: new Intl.NumberFormat(BUILDER_LOCALE, { style: 'unit', unit: 'kilobyte', unitDisplay: 'narrow', maximumFractionDigits: 1 }),
  megabyte: new Intl.NumberFormat(BUILDER_LOCALE, { style: 'unit', unit: 'megabyte', unitDisplay: 'narrow', maximumFractionDigits: 1 }),
};

/** A file size as people read it: 840 B, 12.5 kB, 3.2 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return sizeFormats.byte.format(bytes);
  if (bytes < 1_000_000) return sizeFormats.kilobyte.format(bytes / 1000);
  return sizeFormats.megabyte.format(bytes / 1_000_000);
}

const STATUS_MESSAGES: Record<string, MessageId> = {
  complete: M['responses.status.complete'],
  spam: M['responses.status.spam'],
  pending_payment: M['responses.status.pending_payment'],
  payment_failed: M['responses.status.payment_failed'],
  pending_scan: M['responses.status.pending_scan'],
  pending_guardian_consent: M['responses.status.pending_guardian_consent'],
  archived: M['responses.status.archived'],
  trashed: M['responses.status.trashed'],
};

/** What a processing state is called; a state this build does not know is shown as the API named it. */
export function statusLabel(status: string): string {
  const id = STATUS_MESSAGES[status];
  return id ? t(id) : status;
}

/**
 * The version a response was received on: `v3`, "Unpublished" for a response filed under the stand-in of a form that was
 * never published (version 0), and "Unknown" when the API could not say.
 */
export function versionLabel(versionNumber: number | null): string {
  if (versionNumber === null) return t(M['responses.version_unknown']);
  if (versionNumber === 0) return t(M['responses.version_unpublished']);
  return t(M['responses.version'], { n: versionNumber });
}
