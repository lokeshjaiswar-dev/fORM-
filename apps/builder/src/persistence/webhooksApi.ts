import { z } from 'zod';
import { WebhookConfigSchema, WebhookPayloadMappingSchema, type WebhookPayloadMapping } from '@form/schema';
import { ApiUnreachable } from '@/auth/client';
import { orgCall, problemOf, type Reply } from '@/persistence/draftsApi';

/*
 * The builder's side of a form's webhooks API (WP-1.18, apps/api/src/routes/webhooks.ts): the webhooks, their one-time
 * signing secret and the delivery log with replay. Every call names its org (`X-FR-Org`) and needs `data.route`: sending
 * answers to an outside address is a disclosure, so a role without it gets a 403 from every route here.
 *
 * The signing secret is returned twice only, by `createWebhook` and `rotateWebhookSecret`, and never by a read: the
 * server keeps it sealed. This module hands it to the caller once and keeps nothing.
 */

/** The events a webhook may subscribe to, from the schema twin of the API's `WEBHOOK_EVENTS`. */
export const WEBHOOK_EVENTS = WebhookConfigSchema.shape.events.element.options;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** The states of one delivery (`webhook_deliveries.status`). */
export const DELIVERY_STATUSES = ['pending', 'retrying', 'succeeded', 'failed', 'dead'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** `fieldKeys` of a webhook: every field of its purposes, or only the keys named. */
export const ALL_IN_PURPOSES = 'all_in_purposes' as const;
export type FieldKeys = string[] | typeof ALL_IN_PURPOSES;

const webhookSchema = z.object({
  id: z.string(),
  formId: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  keyBy: z.enum(['key', 'id']),
  fieldKeys: z.union([z.array(z.string()), z.literal(ALL_IN_PURPOSES)]),
  purposeIds: z.array(z.string()),
  files: z.enum(['signed_urls', 'none']),
  /** 'json' (standard payload unless mapped) or 'xml'. */
  bodyFormat: z.enum(['json', 'xml']).default('json'),
  /** The custom body: dotted paths to answers, or null for the standard payload. */
  payloadMapping: WebhookPayloadMappingSchema.nullable().default(null),
  /** The last four characters of the signing secret in force: all that can be shown of it. */
  secretHint: z.string(),
  secretRotatedAt: z.string().nullable(),
  consecutiveFailures: z.number().int().min(0),
  /** Why the webhook is off, when the worker switched it off after repeated failures. */
  disabledReason: z.string().nullable(),
  /** The revision to send back in `If-Match` when saving. */
  rev: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** A webhook as the API reports it. It never carries the signing secret. */
export type Webhook = z.infer<typeof webhookSchema>;

const listSchema = z.object({ items: z.array(webhookSchema) });
const createdSchema = webhookSchema.extend({ secret: z.string() });
const issuedSchema = z.object({ secret: z.string(), secretHint: z.string(), secretRotatedAt: z.string().nullable() });

const deliverySchema = z.object({
  id: z.string(),
  webhookId: z.string(),
  event: z.enum(WEBHOOK_EVENTS),
  submissionId: z.string().nullable(),
  status: z.enum(DELIVERY_STATUSES),
  attempt: z.number().int().min(0),
  httpStatus: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  /** At most 1 KB of the receiver's answer, scrubbed by the worker; null once it is older than 30 days. */
  responseSnippet: z.string().nullable(),
  /** The delivery this one sends again, when it is a replay. */
  replayOf: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  createdAt: z.string(),
});

/** One delivery of one event, as the log lists it. */
export type Delivery = z.infer<typeof deliverySchema>;

const pageSchema = z.object({ items: z.array(deliverySchema), nextCursor: z.string().nullable() });

/** A page of the delivery log, newest first; `nextCursor` is null on the last page. */
export type DeliveryPage = z.infer<typeof pageSchema>;

/** What a member sets on a webhook: the whole of it, as a save replaces every setting. */
export interface WebhookInput {
  url: string;
  enabled: boolean;
  events: WebhookEvent[];
  keyBy: 'key' | 'id';
  fieldKeys: FieldKeys;
  purposeIds: string[];
  files: 'signed_urls' | 'none';
  bodyFormat: 'json' | 'xml';
  payloadMapping: WebhookPayloadMapping | null;
}

/** The answer to creating a webhook: the webhook, and its signing secret, which is shown this once. */
export interface CreatedWebhook {
  webhook: Webhook;
  secret: string;
}

/** The answer to replacing a signing secret: the new secret (shown this once) and what may be shown of it later. */
export type IssuedSecret = z.infer<typeof issuedSchema>;

/** Someone saved the webhook first (409 `WEBHOOK_REV_CONFLICT`): nothing was written; read it again. */
export class WebhookConflict extends Error {
  constructor() {
    super('The webhook changed since it was read.');
    this.name = 'WebhookConflict';
  }
}

const base = (formId: string) => `/v1/forms/${encodeURIComponent(formId)}/webhooks`;
const one = (formId: string, id: string) => `${base(formId)}/${encodeURIComponent(id)}`;

function read<T>(reply: Reply, schema: z.ZodType<T>): T {
  if (!reply.ok) throw problemOf(reply);
  const parsed = schema.safeParse(reply.json);
  if (!parsed.success) throw new ApiUnreachable();
  return parsed.data;
}

/** The form's webhooks, oldest first. */
export async function listWebhooks(org: string, formId: string): Promise<Webhook[]> {
  return read(await orgCall(org, 'GET', base(formId)), listSchema).items;
}

/**
 * Makes a webhook. The server decides its id and its signing secret, and checks the purposes and the address (422
 * `MISSING_PURPOSE`, 422 `EGRESS_DENIED`, both thrown as `ApiProblem`s). The secret comes back here and nowhere else.
 */
export async function createWebhook(org: string, formId: string, input: WebhookInput): Promise<CreatedWebhook> {
  const { secret, ...webhook } = read(await orgCall(org, 'POST', base(formId), input), createdSchema);
  return { webhook, secret };
}

/** Replaces a webhook's settings if the server is still at revision `rev` (`If-Match`); a stale revision is `WebhookConflict`. */
export async function saveWebhook(org: string, formId: string, id: string, input: WebhookInput, rev: number): Promise<Webhook> {
  const reply = await orgCall(org, 'PUT', one(formId, id), input, { 'if-match': `"${rev}"` });
  if (reply.status === 409 && (reply.json as { code?: unknown } | null)?.code === 'WEBHOOK_REV_CONFLICT') throw new WebhookConflict();
  return read(reply, webhookSchema);
}

/** Deletes a webhook with its signing secret and its delivery log. */
export async function deleteWebhook(org: string, formId: string, id: string): Promise<void> {
  const reply = await orgCall(org, 'DELETE', one(formId, id));
  if (!reply.ok) throw problemOf(reply);
}

/** Replaces the signing secret. The old one stops verifying at once; the new one is returned here and nowhere else. */
export async function rotateWebhookSecret(org: string, formId: string, id: string): Promise<IssuedSecret> {
  return read(await orgCall(org, 'POST', `${one(formId, id)}/rotate-secret`, {}), issuedSchema);
}

export interface DeliveryQuery {
  status?: DeliveryStatus | undefined;
  /** The `nextCursor` of the previous page, passed back unchanged. */
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** A page of a webhook's delivery log, newest first. */
export async function listDeliveries(org: string, formId: string, id: string, query: DeliveryQuery = {}): Promise<DeliveryPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.status) params.set('status', query.status);
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  return read(await orgCall(org, 'GET', `${one(formId, id)}/deliveries${qs ? `?${qs}` : ''}`), pageSchema);
}

/**
 * Sends a delivery again: the server adds a new delivery for the same event and queues it (a webhook that is off is a 409
 * `WEBHOOK_DISABLED`). The answer is the new delivery, which the log lists from its next read.
 */
export async function replayDelivery(org: string, formId: string, id: string, deliveryId: string): Promise<Delivery> {
  return read(await orgCall(org, 'POST', `${one(formId, id)}/deliveries/${encodeURIComponent(deliveryId)}/replay`, {}), deliverySchema);
}
