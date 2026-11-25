import { z } from 'zod';

/*
 * fp-bridge/1: the postMessage protocol between the DMS classic upload step 2 (parent) and `/embed/dms-upload` (child).
 * A zod mirror of contract/fp-bridge-v1.schema.json (DESIGN.md section 4); the fixtures test keeps the two in step.
 * Every payload is a closed object, so a credential cannot ride along unnoticed. The `dmsElement` is the one open
 * shape: it is what DMS's `document-form-builders` returns and DMS adds keys to it over time.
 */

export const PROTOCOL = 'fp-bridge/1' as const;
export const PROTOCOL_VERSION = '1' as const;

const msgId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const fieldId = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
const dmsValue = z.string().max(50_000);
const values = z.record(fieldId, dmsValue);
const option = z.looseObject({ name: z.string(), value: z.string() });

export const DmsElementSchema = z.looseObject({
  id: fieldId,
  type: z.string().min(1),
  value: z.string().min(1).max(264),
  name: z.string().optional(),
  label: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  numeric: z.boolean().optional(),
  specialChars: z.boolean().optional(),
  primary: z.boolean().optional(),
  increment: z.boolean().optional(),
  incrementOption: z.string().nullable().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  autoIncrementPattern: z.union([z.string(), z.number().int()]).nullable().optional(),
  autoIncrementValue: z.union([z.string(), z.number().int()]).nullable().optional(),
  isDefaultToDate: z.boolean().optional(),
  defaultDate: z.string().optional(),
  options: z.array(option).optional(),
  parent_field_id: fieldId.optional(),
  field_source: z.enum(['doctype', 'master']).optional(),
});
export type BridgeElement = z.infer<typeof DmsElementSchema>;

const ready = z.strictObject({ version: z.literal(PROTOCOL_VERSION), capabilities: z.array(z.enum(['options', 'readOnly'])) });
const init = z.strictObject({
  doctypeFields: z.array(DmsElementSchema).max(200),
  masterFields: z.array(DmsElementSchema).max(200),
  values,
  locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  readOnly: z.boolean(),
  context: z.strictObject({ mode: z.enum(['create', 'edit']), today: z.string().regex(/^\d{2}-\d{2}-\d{4}$/) }),
});
const initialized = z.strictObject({ fieldCount: z.number().int().min(0), unsupported: z.array(fieldId) });
const resize = z.strictObject({ height: z.number().int().min(0).max(100_000) });
const change = z.strictObject({ values, valid: z.boolean() });
const optionsRequest = z.strictObject({
  fieldId,
  parentValue: z.string().nullable(),
  page: z.number().int().min(1).max(100),
  search: z.string().max(200),
});
const optionsResult = z.strictObject({ fieldId, options: z.array(option).max(500), hasMore: z.boolean() });
const validate = z.strictObject({});
export const FIELD_ERROR_CODES = ['required', 'pattern', 'too_long', 'invalid_email', 'not_a_number', 'not_integer', 'below_min', 'above_max', 'not_in_options', 'invalid_date'] as const;
export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];
const fieldError = z.strictObject({ fieldId, code: z.enum(FIELD_ERROR_CODES), message: z.string().max(500) });
const validated = z.strictObject({ valid: z.boolean(), errors: z.array(fieldError), values });
export const ERROR_CODES = ['unsupported_version', 'invalid_init', 'unsupported_field_type', 'render_failed', 'origin_rejected', 'internal'] as const;
const error = z.strictObject({ code: z.enum(ERROR_CODES), message: z.string().max(500).optional(), fatal: z.boolean() });

const lookupId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const lookupRequest = z.strictObject({ lookupId, search: z.string().max(100) });
export const LOOKUP_STATUSES = ['ok', 'unknown_lookup', 'forbidden', 'unavailable', 'rate_limited'] as const;
export type LookupStatus = (typeof LOOKUP_STATUSES)[number];
const lookupResult = z.strictObject({
  lookupId,
  status: z.enum(LOOKUP_STATUSES),
  rows: z.array(z.strictObject({ label: z.string().max(200), cells: z.record(fieldId, z.string().max(1000)) })).max(20),
  truncated: z.boolean(),
});

const optionalReply = msgId.optional();
const envelope = <T extends string, P extends z.ZodType, R extends z.ZodType = typeof optionalReply>(type: T, payload: P, replyTo?: R) =>
  z.strictObject({
    protocol: z.literal(PROTOCOL),
    type: z.literal(type),
    id: msgId,
    replyTo: (replyTo ?? optionalReply) as R,
    payload,
  });

export const MessageSchema = z.discriminatedUnion('type', [
  envelope('ready', ready),
  envelope('init', init),
  envelope('initialized', initialized, msgId),
  envelope('resize', resize),
  envelope('change', change),
  envelope('options.request', optionsRequest),
  envelope('options.result', optionsResult, msgId),
  envelope('lookup.request', lookupRequest),
  envelope('lookup.result', lookupResult, msgId),
  envelope('validate', validate),
  envelope('validated', validated, msgId),
  envelope('error', error),
]);

export type BridgeMessage = z.infer<typeof MessageSchema>;
export type MessageType = BridgeMessage['type'];
export type PayloadOf<T extends MessageType> = Extract<BridgeMessage, { type: T }>['payload'];
export type InitPayload = PayloadOf<'init'>;
export type LookupResultPayload = PayloadOf<'lookup.result'>;
export type ValidatedPayload = PayloadOf<'validated'>;
export type FieldError = z.infer<typeof fieldError>;

/** Messages the child sends and the ones it accepts; anything else from the parent is ignored. */
export const OUTBOUND_TYPES = ['ready', 'initialized', 'resize', 'change', 'options.request', 'lookup.request', 'validated', 'error'] as const satisfies readonly MessageType[];
export const INBOUND_TYPES = ['init', 'options.result', 'lookup.result', 'validate'] as const satisfies readonly MessageType[];
export type OutboundType = (typeof OUTBOUND_TYPES)[number];
export type InboundType = (typeof INBOUND_TYPES)[number];
export type InboundMessage = Extract<BridgeMessage, { type: InboundType }>;

export const isInboundType = (type: unknown): type is InboundType => typeof type === 'string' && (INBOUND_TYPES as readonly string[]).includes(type);

export type ParseResult =
  | { ok: true; message: BridgeMessage }
  /** `protocol`: an fp-bridge envelope of another version. `invalid`: right protocol, wrong shape (`type` when readable). `foreign`: not ours at all. */
  | { ok: false; reason: 'protocol' | 'invalid' | 'foreign'; type?: string; detail?: string };

/** Schema-checks one received value. Never throws. */
export function parseMessage(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'foreign' };
  const head = raw as { protocol?: unknown; type?: unknown };
  if (typeof head.protocol !== 'string' || !head.protocol.startsWith('fp-bridge/')) return { ok: false, reason: 'foreign' };
  if (head.protocol !== PROTOCOL) return { ok: false, reason: 'protocol', detail: head.protocol.slice(0, 40) };
  const parsed = MessageSchema.safeParse(raw);
  if (parsed.success) return { ok: true, message: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    reason: 'invalid',
    ...(typeof head.type === 'string' ? { type: head.type } : {}),
    detail: issue ? `${issue.path.join('.') || '(message)'}: ${issue.message}`.slice(0, 200) : 'invalid',
  };
}
