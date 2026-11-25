import type { WebhookEvent } from '@form/db';
import type { BlockId, CompiledForm, FormDefinition } from '@form/schema';
import { disclosableFields, disclosedFieldKeys, MASK, type DisclosableField } from '../disclosure.ts';

/*
 * The body of a webhook request (WP-1.18, INT-01). It is built from `disclosableFields`, the one filter every notification,
 * webhook and export goes through, so a field that is out of the webhook's purposes, omitted or masked cannot reach the
 * receiver by a path that forgot to check. This file only decides the shape: what a field is called, and how a value is typed.
 *
 *   {
 *     "id": "<event id>",                       the same on every retry and every replay of the event
 *     "event": "submission.created",
 *     "createdAt": "<ISO instant>",             when the event was queued
 *     "form": { "id": "<form id>" },
 *     "submission": { "id": "<response id>", "submittedAt": "<ISO instant>", "answers": { "<key>": <value> } }
 *   }
 *
 * `answers` has one entry per field the webhook may receive: the stored value, typed as the form stores it (a phone is
 * `{ e164, country }`, a number a decimal string, a file list its metadata); `MASK` for a field that is withheld; `null` for a
 * field that is allowed but was not answered. A field outside the webhook's purposes has no entry at all.
 */

export interface WebhookPayload {
  id: string;
  event: WebhookEvent;
  createdAt: string;
  form: { id: string };
  submission: { id: string; submittedAt: string; answers: Record<string, unknown> };
}

export interface WebhookPayloadInput {
  /** The id of the event: the first delivery's id, so a retry or a replay of it carries the same one. */
  eventId: string;
  event: WebhookEvent;
  /** When the event was queued (the first delivery's `created_at`). */
  createdAt: Date;
  formId: string;
  submission: {
    id: string;
    receivedAt: Date;
    /** The stored answers by block id (`submissions.answers`). */
    answers: Readonly<Record<string, unknown>>;
  };
  /** The version the response was received on, and its compiled taint. */
  definition: FormDefinition;
  compiled: Pick<CompiledForm, 'taint'>;
  webhook: {
    /** `webhooks.purpose_ids`: the purposes this destination is declared for. */
    purposeIds: readonly string[];
    /** `webhooks.field_keys`: narrows the purpose filter further, never widens it. */
    fieldKeys: readonly string[] | 'all_in_purposes';
    /** `webhooks.key_by`: name the answers by the field's key or by its block id. */
    keyBy: 'key' | 'id';
  };
}

export interface BuiltWebhookPayload {
  payload: WebhookPayload;
  /** The keys of the fields whose value is in the body: what the disclosures row names. A masked or unanswered field is not in it. */
  sentKeys: string[];
  /** The same entries as `payload.submission.answers`, by FIELD KEY whatever `keyBy` is: what a payload mapping reads from. Null-prototype. */
  byKey: Readonly<Record<string, unknown>>;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const without = (value: unknown, keys: readonly string[]): unknown => {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
};

/**
 * A stored value as a receiver is sent it: the same shape, minus what the server keeps for itself (the proof that an email
 * address was confirmed by a code, the token that held an appointment slot, the evidence of a signature), and a file as its
 * metadata. A file never carries a URL here: signed file URLs wait for the storage work (WP-1.14).
 */
function sendable(type: string, value: unknown, definition: FormDefinition, keyBy: 'key' | 'id'): unknown {
  switch (type) {
    case 'email':
      return without(value, ['otpProof']);
    case 'appointment':
      return without(value, ['holdToken']);
    case 'signature':
      return without(value, ['audit']);
    case 'file_upload':
      return Array.isArray(value)
        ? value.map((f: unknown) =>
            isRecord(f) ? { fileId: f['fileId'], name: f['name'], sizeBytes: f['sizeBytes'], mime: f['mime'], sha256: f['sha256'], ...(f['scan'] !== undefined ? { scan: f['scan'] } : {}) } : null,
          )
        : value;
    case 'repeating_group':
      return groupRows(value, definition, keyBy);
    default:
      return value;
  }
}

/**
 * The rows of a repeating group. Its children are stored as tagged answers by block id, and one of them may be sealed
 * (unreadable here): that one is `MASK`, never the sealed bytes. A child the version has no field for is dropped, because
 * the server cannot say it is safe to send. `disclosableFields` already masked the whole group when any child is out of
 * purpose or protected, so only a group that is entirely allowed gets this far.
 */
function groupRows(value: unknown, definition: FormDefinition, keyBy: 'key' | 'id'): unknown {
  if (!isRecord(value) || !Array.isArray(value['rows'])) return MASK;
  const rows = (value['rows'] as unknown[]).map((row) => {
    if (!isRecord(row) || !isRecord(row['values'])) return null;
    const values: Json = {};
    for (const [blockId, stored] of Object.entries(row['values'])) {
      const block = definition.blocks[blockId as BlockId];
      if (!block || !('key' in block)) continue;
      const readable = isRecord(stored) && stored['type'] === block.type && stored['value'] !== undefined;
      values[keyBy === 'key' ? block.key : block.id] = readable ? sendable(block.type, stored['value'], definition, keyBy) : MASK;
    }
    return { rowId: row['rowId'], values };
  });
  return { rows };
}

function entryOf(field: DisclosableField, definition: FormDefinition, keyBy: 'key' | 'id'): unknown {
  if (field.masked) return MASK;
  if (!field.answered) return null;
  return sendable(field.type, field.value, definition, keyBy);
}

/** The request body of one delivery, and the field keys it carries (for the disclosures ledger). */
export function buildWebhookPayload(input: WebhookPayloadInput): BuiltWebhookPayload {
  const { webhook, definition } = input;
  const fields = disclosableFields({
    definition,
    compiled: input.compiled,
    answers: input.submission.answers,
    purposeIds: webhook.purposeIds,
    channel: 'webhook',
    ...(webhook.fieldKeys === 'all_in_purposes' ? {} : { fieldKeys: webhook.fieldKeys }),
  });
  const answers: Record<string, unknown> = {};
  const byKey: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const entry = entryOf(field, definition, webhook.keyBy);
    answers[webhook.keyBy === 'key' ? field.key : field.blockId] = entry;
    byKey[field.key] = entry;
  }
  return {
    payload: {
      id: input.eventId,
      event: input.event,
      createdAt: input.createdAt.toISOString(),
      form: { id: input.formId },
      submission: { id: input.submission.id, submittedAt: input.submission.receivedAt.toISOString(), answers },
    },
    sentKeys: disclosedFieldKeys(fields),
    byKey,
  };
}
