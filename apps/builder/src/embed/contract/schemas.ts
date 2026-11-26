import { z } from 'zod';

/*
 * The fORM- <-> DMS contract of run dmsplus-int (DESIGN.md section 3, SEC-DESIGN.md sections 1, 3.4, 5, 6.3, 7.2).
 * Canonical home: this directory (fORM- `dev`). dms-api, classic and dms-ui keep byte-identical copies of the fixtures
 * in `__fixtures__/` (tools/contracts.manifest, tools/contract-cmp.sh); no repo imports this file at run time except
 * fORM- itself, the other repos replay the fixtures with their own parsers.
 *
 * Every object is closed (`strictObject`): an unknown key is invalid, so a credential or a value cannot ride along
 * unnoticed. The one open shape is the DMS form element (`BridgeElementV2`), because DMS adds keys to it over time.
 *
 * Pure functions that apply these rules to a URL, a fragment or a share link live in `./rules.ts`; `./index.ts` exports both.
 */

export const CONTRACT_VERSION = 1 as const;

/* ------------------------------------------------------------------------------------------------ shared pieces */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An opaque identifier as DMS and fORM- exchange it (tenant, workspace, user, record ids; the same set `launch.ts` accepts). */
const IDENT_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** `^[A-Za-z0-9_-]{1,64}$`: the form of `fp_master_id`, `fp_record_id`, message ids. */
export const RETURN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** `^[A-Z_]{1,64}$`: the form of `fp_code`. */
export const RETURN_CODE_RE = /^[A-Z_]{1,64}$/;
/** 32 random bytes, base64url without padding: a PKCE verifier and an S256 challenge are both 43 characters. */
export const B64URL_43_RE = /^[A-Za-z0-9_-]{43}$/;
/** Launch ticket: `fpt1_` + 43 base64url characters (SD-01). */
export const TICKET_RE = /^fpt1_[A-Za-z0-9_-]{43}$/;
/** Session credential: `fps1_` + 43 base64url characters (SD-01). */
export const CREDENTIAL_RE = /^fps1_[A-Za-z0-9_-]{43}$/;

const uuid = z.string().regex(UUID_RE, 'not a uuid');
const ident = z.string().regex(IDENT_RE, 'unexpected characters in an id');
const b64url43 = z.string().regex(B64URL_43_RE, 'not 43 base64url characters');
const isoDateTime = z.string().min(10).max(40);

/* ------------------------------------------------------------------------------------------------ modes, scopes, clients */

/** The two modes a ticket can be issued for. `dms-upload` is reserved: issuance answers `422 MODE_NOT_TICKETED` (SEC 1.3). */
export const TICKET_MODES = ['dms-master', 'dms-record'] as const;
export type TicketMode = (typeof TICKET_MODES)[number];
export const RESERVED_MODES = ['dms-upload'] as const;

export const CLIENTS = ['classic', 'dms-ui'] as const;
export type Client = (typeof CLIENTS)[number];

export const CLASSIFICATIONS = ['public', 'confidential', 'restricted'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const SCOPES = ['master:create', 'master:read', 'master:update', 'master:usage', 'lookup:read', 'record:read', 'record:create', 'record:update'] as const;
export type Scope = (typeof SCOPES)[number];

/** Scopes a session holds, by mode and variant (SEC 1.6). A created master turns the create set into the edit set. */
export const SCOPES_BY_MODE = {
  'dms-master': {
    create: ['master:create', 'lookup:read'],
    edit: ['master:read', 'master:update', 'master:usage', 'lookup:read'],
  },
  'dms-record': {
    add: ['master:read', 'record:create', 'lookup:read'],
    edit: ['master:read', 'record:read', 'record:update', 'lookup:read'],
  },
} as const satisfies Record<TicketMode, Record<string, readonly Scope[]>>;

/* ------------------------------------------------------------------------------------------------ launch ticket (SEC 1.4) */

/** The seed the DMS wizard hands to a create (DEC-04.1): validated server-side against the workspace's doc types and folders. */
export const MasterSeedSchema = z.strictObject({
  name: z.string().min(1).max(255),
  doctype_ids: z.array(uuid).max(500),
  folder_ids: z.array(uuid).max(500),
  classification: z.enum(CLASSIFICATIONS).nullable(),
});
export type MasterSeed = z.infer<typeof MasterSeedSchema>;

/** `POST /api/dms/v1/formplus/launch-tickets`. Shape only: origins, path prefixes, rights and membership are server rules (see `evaluateIssuance`). */
export const TicketRequestSchema = z
  .strictObject({
    mode: z.enum(TICKET_MODES),
    master_id: uuid.optional(),
    record_id: ident.optional(),
    master: MasterSeedSchema.optional(),
    return_url: z.string().min(1).max(2048),
    reconnect_url: z.string().min(1).max(2048),
    challenge: b64url43,
    challenge_method: z.literal('S256'),
    client: z.enum(CLIENTS),
    reconnect: z.boolean().optional(),
  })
  .superRefine((req, ctx) => {
    const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (req.mode === 'dms-record') {
      if (req.master_id === undefined) bad('master_id', 'master_id is required for dms-record');
      if (req.master !== undefined) bad('master', 'master is only for a dms-master create');
    } else {
      if (req.record_id !== undefined) bad('record_id', 'record_id is only for dms-record');
      if (req.master !== undefined && req.master_id !== undefined) bad('master', 'master is only for a create (no master_id)');
    }
  });
export type TicketRequest = z.infer<typeof TicketRequestSchema>;

export const TicketResponseSchema = z.strictObject({
  ticket: z.string().regex(TICKET_RE),
  expires_in: z.number().int().min(1).max(600),
});
export type TicketResponse = z.infer<typeof TicketResponseSchema>;

/** `POST /api/dms/v1/formplus/launch-tickets/exchange` (no Authorization header). */
export const ExchangeRequestSchema = z.strictObject({
  ticket: z.string().regex(TICKET_RE),
  verifier: b64url43,
});
export type ExchangeRequest = z.infer<typeof ExchangeRequestSchema>;

/** What the exchange answers about the launch (SEC 1.5). `master_seed` is set for a create only, `master_id` for an edit or a record. */
export const SessionContextSchema = z.strictObject({
  sid: uuid,
  mode: z.enum(TICKET_MODES),
  tenant_id: ident,
  workspace_id: ident,
  master_id: uuid.nullable(),
  record_id: ident.nullable(),
  master_seed: MasterSeedSchema.nullable(),
  return_url: z.string().min(1).max(2048),
  reconnect_url: z.string().min(1).max(2048),
  user: z.strictObject({ id: ident, name: z.string().max(255) }),
  can: z.strictObject({ reveal_fields: z.boolean() }),
});
export type SessionContext = z.infer<typeof SessionContextSchema>;

export const ExchangeResponseSchema = z.strictObject({
  credential: z.string().regex(CREDENTIAL_RE),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().min(1),
  absolute_expires_in: z.number().int().min(1),
  context: SessionContextSchema,
});
export type ExchangeResponse = z.infer<typeof ExchangeResponseSchema>;

/* ------------------------------------------------------------------------------------------------ error contract (DESIGN 3.4) */

/** Every `code` of the DESIGN 3.4 table. Order is the table's. */
export const ERROR_CODES = [
  'FP_ORIGIN_DENIED',
  'FP_TICKET_CHANNEL_DENIED',
  'WORKSPACE_FORBIDDEN',
  'FORBIDDEN_RIGHT',
  'NOT_FOUND',
  'MASTER_NOT_CONVERTED',
  'MODE_NOT_TICKETED',
  'VALIDATION_FAILED',
  'FP_TICKET_INVALID',
  'LAUNCH_STORE_UNAVAILABLE',
  'FP_SESSION_INVALID',
  'FP_CONTEXT_MISMATCH',
  'FP_SCOPE_DENIED',
  'FIELD_VISIBILITY_FORBIDDEN',
  'PRIMARY_CANNOT_BE_HIDDEN',
  'FIELD_OMITTED',
  'UNKNOWN_FIELD',
  'REMOVAL_NOT_CONFIRMED',
  'REMOVAL_COUNT_CHANGED',
  'REMOVAL_INCOMPLETE',
  'MASTER_CHANGED',
  'SECRET_MASK_NOT_ALLOWED',
  'HIDDEN_FIELD_NOT_WRITABLE',
  'MASTER_ID_MISMATCH',
  'LINK_EXPIRED',
  'RATE_LIMITED',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

const requestId = z.string().regex(UUID_RE).nullable();

/** The envelope of every new failure path: tickets, session, scope, removal, hidden/secret, share expiry, `fp-*` throttles. */
export const ErrorEnvelopeSchema = z.strictObject({
  success: z.literal(false),
  code: ErrorCodeSchema,
  message: z.string().min(1).max(500),
  details: z.record(z.string(), z.unknown()).optional(),
  request_id: requestId,
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** Same envelope with any well-formed code: what a client reads from a newer server (an unknown code shows the generic message). */
export const AnyErrorEnvelopeSchema = ErrorEnvelopeSchema.extend({ code: z.string().regex(RETURN_CODE_RE) });
export type AnyErrorEnvelope = z.infer<typeof AnyErrorEnvelopeSchema>;

/** One row of `fp-errors.fixtures.json`: the status, the default English message for the DMS pages, and what a client may do next. */
export const ErrorCodeRowSchema = z.strictObject({
  code: ErrorCodeSchema,
  status: z.number().int().min(400).max(599),
  message: z.string().min(1).max(500),
  /** The UI offers "Reconnect to DMS" (a new ticket through the DMS reconnect page). */
  reconnect: z.boolean(),
  /** The same request, repeated unchanged, may succeed (store down, throttled, nothing was written). */
  retryable: z.boolean(),
});
export type ErrorCodeRow = z.infer<typeof ErrorCodeRowSchema>;

/* ------------------------------------------------------------------------------------------------ return parameters (DESIGN 3.5) */

export const RETURN_STATUSES = ['saved', 'cancelled', 'error'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

/** The `fp_*` query parameters fORM- appends to `return_url`. `fp_code` only with `error`; `fp_record_id` only with `saved`. */
export const ReturnParamsSchema = z
  .strictObject({
    fp_status: z.enum(RETURN_STATUSES),
    fp_master_id: z.string().regex(RETURN_ID_RE).optional(),
    fp_record_id: z.string().regex(RETURN_ID_RE).optional(),
    fp_code: z.string().regex(RETURN_CODE_RE).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.fp_code !== undefined && p.fp_status !== 'error') ctx.addIssue({ code: 'custom', path: ['fp_code'], message: 'fp_code is only valid with fp_status=error' });
    if (p.fp_record_id !== undefined && p.fp_status !== 'saved') ctx.addIssue({ code: 'custom', path: ['fp_record_id'], message: 'fp_record_id is only valid with fp_status=saved' });
  });
export type ReturnParams = z.infer<typeof ReturnParamsSchema>;

/* ------------------------------------------------------------------------------------------------ session routes (DESIGN 3.3, SEC 1.6) */

export interface SessionRoute {
  /** dms-api route name (`MasterRecordRequest` matches the legacy name and this twin). */
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path template relative to `apiBase`, as the fORM- repositories write it; `null` for routes that have no legacy twin. */
  legacy: string | null;
  /** Path template relative to `apiBase` of the session twin. */
  session: string;
  /** Scope the session must hold, `any` = every session (SEC 1.6). */
  scope: Scope | 'any';
}

/** The exact mapping the fORM- session client applies; any path not in this table is a programming error and is never sent. */
export const SESSION_ROUTE_MAP = [
  { name: 'fp.s.master-form.store', method: 'POST', legacy: 'dms/v1/master/form', session: 'dms/v1/formplus/s/master/form', scope: 'master:create' },
  { name: 'fp.s.master-form.show', method: 'GET', legacy: 'dms/v1/master/form/{id}', session: 'dms/v1/formplus/s/master/form/{id}', scope: 'master:read' },
  { name: 'fp.s.master-form.update', method: 'PATCH', legacy: 'dms/v1/master/form/{id}', session: 'dms/v1/formplus/s/master/form/{id}', scope: 'master:update' },
  { name: 'fp.s.master-form.field-usage', method: 'GET', legacy: 'dms/v1/master/form/{id}/field-usage', session: 'dms/v1/formplus/s/master/form/{id}/field-usage', scope: 'master:usage' },
  { name: 'fp.s.masters.show', method: 'GET', legacy: 'dms/masters/{id}', session: 'dms/v1/formplus/s/masters/{id}', scope: 'lookup:read' },
  { name: 'fp.s.master-records.index', method: 'GET', legacy: 'dms/master-records', session: 'dms/v1/formplus/s/master-records', scope: 'lookup:read' },
  { name: 'fp.s.master-records.show', method: 'GET', legacy: 'dms/master-records/{id}', session: 'dms/v1/formplus/s/master-records/{id}', scope: 'record:read' },
  { name: 'fp.s.master-records.store', method: 'POST', legacy: 'dms/master-records', session: 'dms/v1/formplus/s/master-records', scope: 'record:create' },
  { name: 'fp.s.master-records.update', method: 'PATCH', legacy: 'dms/master-records/{id}', session: 'dms/v1/formplus/s/master-records/{id}', scope: 'record:update' },
  { name: 'fp.s.session.show', method: 'GET', legacy: null, session: 'dms/v1/formplus/s/session', scope: 'any' },
  { name: 'fp.s.session.destroy', method: 'DELETE', legacy: null, session: 'dms/v1/formplus/s/session', scope: 'any' },
] as const satisfies readonly SessionRoute[];

/* ------------------------------------------------------------------------------------------------ field usage (SEC 7.2) */

/** `data` of `GET .../master/form/{id}/field-usage`: counts only, never values. Hidden fields are listed only for revealers. */
export const FieldUsageSchema = z.strictObject({
  updated_at: isoDateTime,
  total_records: z.number().int().min(0),
  fields: z.array(
    z.strictObject({
      id: uuid,
      name: z.string().min(1).max(264),
      records_with_value: z.number().int().min(0),
    }),
  ),
});
export type FieldUsage = z.infer<typeof FieldUsageSchema>;

/* ------------------------------------------------------------------------------------------------ share links (SEC 6.3) */

/** New share tokens: `e` + 8 lowercase hex (expiry, unix seconds) + 32 lowercase alphanumerics = 41 characters. */
export const SHARE_TOKEN_V2_RE = /^e[0-9a-f]{8}[a-z0-9]{32}$/;
/** Legacy tokens: `Str::lower(Str::random(32))`. */
export const SHARE_TOKEN_LEGACY_RE = /^[a-z0-9]{32}$/;
export const SHARE_LINK_KINDS = ['public_v2', 'invite_v2', 'public_legacy', 'invite_legacy', 'slug'] as const;
export const ShareLinkKindSchema = z.enum(SHARE_LINK_KINDS);
export type ShareLinkKind = z.infer<typeof ShareLinkKindSchema>;

/** The expiry a v2 token carries, as a unix time, or null when the token is not v2. */
export function shareTokenExpiry(token: string): number | null {
  return SHARE_TOKEN_V2_RE.test(token) ? Number.parseInt(token.slice(1, 9), 16) : null;
}

/** The 7 element types DMS masters have (DEC-04.5: both share renderers handle all of them). */
export const DMS_ELEMENT_TYPES = ['textinput', 'numberinput', 'email', 'phonenumber', 'multilineinput', 'dropdown', 'date'] as const;
export type DmsElementType = (typeof DMS_ELEMENT_TYPES)[number];

const option = z.looseObject({ name: z.string(), value: z.string() });

/**
 * One element of an anonymous share payload (`buildFormPayloadv2`): never hidden, secret fields flagged and write-only
 * (the payload has no value for them, and no key carries one).
 */
export const ShareElementSchema = z.looseObject({
  id: uuid,
  type: z.enum(DMS_ELEMENT_TYPES),
  value: z.string().min(1).max(264),
  label: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  options: z.array(option).optional(),
  is_hidden: z.literal(false),
  is_secret: z.boolean(),
});
export type ShareElement = z.infer<typeof ShareElementSchema>;

export const SharePayloadSchema = z.strictObject({
  master_id: uuid,
  master_name: z.string().min(1).max(264),
  form_builders: z.array(ShareElementSchema).max(500),
  primary_key: z.string().nullable(),
  tenant_id: ident.nullable().optional(),
  workspace_id: ident.nullable().optional(),
});
export type SharePayload = z.infer<typeof SharePayloadSchema>;

/** The body of a share read or submit on an expired link (410). */
export const LinkExpiredBodySchema = ErrorEnvelopeSchema.extend({ code: z.literal('LINK_EXPIRED') });

/* ------------------------------------------------------------------------------------------------ fp-bridge/2 (SEC 3.4, DESIGN 3.7) */

export const BRIDGE_V2 = 'fp-bridge/2' as const;

const msgId = z.string().regex(RETURN_ID_RE);
const fieldId = uuid;
const dialogId = z.string().regex(RETURN_ID_RE);
/** Fresh random per submit attempt; the parent accepts one `collected` per `req`. */
const reqToken = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const dmsValue = z.string().max(50_000);
const lookupId = z.string().regex(RETURN_ID_RE);

/** `fp_lookup` on a master element: "Fill from master" (the closed shape `parseFpLookup` accepts). */
export const FpLookupSchema = z.strictObject({
  v: z.literal(1),
  id: lookupId,
  master_id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  label_field_id: z.string().regex(/^[0-9a-fA-F-]{36}$/),
  fill: z.array(z.strictObject({ from: z.string().regex(/^[0-9a-fA-F-]{36}$/), to: z.string().min(1).max(64) })).max(16),
  min_chars: z.number().int().min(0).max(3).optional(),
});
export type FpLookup = z.infer<typeof FpLookupSchema>;

/**
 * A form element as `init` carries it (`/1` element plus the keys of DESIGN 3.7): `is_secret`, `legacy`, `linkedTo`, `optionParents`
 * and `fp_lookup`. Hidden fields are never sent, so `is_hidden`, when present, is `false`. Open: DMS adds keys.
 */
export const BridgeElementV2Schema = z.looseObject({
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
  is_hidden: z.literal(false).optional(),
  is_secret: z.boolean().optional(),
  legacy: z.strictObject({ from: z.string().min(1).max(64), readOnly: z.boolean() }).optional(),
  linkedTo: fieldId.optional(),
  optionParents: z.record(z.string(), z.array(z.string())).optional(),
  fp_lookup: FpLookupSchema.optional(),
});
export type BridgeElementV2 = z.infer<typeof BridgeElementV2Schema>;

const fieldError = z.strictObject({
  fieldId,
  code: z.enum(['required', 'pattern', 'too_long', 'invalid_email', 'not_a_number', 'not_integer', 'below_min', 'above_max', 'not_in_options', 'invalid_date']),
  message: z.string().max(500),
});

const proto = z.literal(BRIDGE_V2);

const hello = z.strictObject({ protocol: proto, type: z.literal('hello') });
const port = z.strictObject({ protocol: proto, type: z.literal('port'), dialogId });
const init = z
  .strictObject({
    protocol: proto,
    type: z.literal('init'),
    dialogId,
    doctypeFields: z.array(BridgeElementV2Schema).max(200),
    masterFields: z.array(BridgeElementV2Schema).max(200),
    /** Prefill by field id. A masked secret is `null` and listed in `masked`; a secret value never crosses. */
    values: z.record(fieldId, dmsValue.nullable()),
    masked: z.array(fieldId).max(200),
    /** Ids of the lookups declared by `fp_lookup` on `masterFields`: the only ids the child may ask for. */
    lookups: z.array(lookupId).max(8),
    locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
    readOnly: z.boolean(),
    context: z.strictObject({ mode: z.enum(['create', 'edit']), today: z.string().regex(/^\d{2}-\d{2}-\d{4}$/) }),
  })
  .superRefine((m, ctx) => {
    const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const all = [...m.doctypeFields, ...m.masterFields];
    const secret = new Set(all.filter((e) => e.is_secret === true).map((e) => e.id.toLowerCase()));
    const masked = new Set(m.masked.map((id) => id.toLowerCase()));
    for (const [id, v] of Object.entries(m.values)) {
      const key = id.toLowerCase();
      if (secret.has(key) && v !== null) fail(['values', id], 'a secret field is never prefilled');
      if (v === null && !masked.has(key)) fail(['values', id], 'a null value must be listed in masked');
    }
    for (const id of m.masked) if (m.values[id] !== null) fail(['masked'], 'a masked id must be present in values with null');
    const known = new Set(all.map((e) => e.id.toLowerCase()));
    for (const id of Object.keys(m.values)) if (!known.has(id.toLowerCase())) fail(['values', id], 'a value for a field that is not in the form');
    const declared = new Set(m.masterFields.flatMap((e) => (e.fp_lookup === undefined ? [] : [e.fp_lookup.id])));
    for (const id of m.lookups) if (!declared.has(id)) fail(['lookups'], `lookup ${id} is not declared by a master field`);
  });
const initialized = z.strictObject({ protocol: proto, type: z.literal('initialized'), dialogId, fieldCount: z.number().int().min(0), unsupported: z.array(fieldId) });
const resize = z.strictObject({ protocol: proto, type: z.literal('resize'), height: z.number().int().min(0).max(100_000) });
/** Replaces `/1` `change`: the child tells the parent that it is valid, dirty and which fields were touched, never what they hold. */
const state = z.strictObject({ protocol: proto, type: z.literal('state'), dialogId, valid: z.boolean(), dirty: z.boolean(), touched: z.array(fieldId).max(200) });
const optionsRequest = z.strictObject({
  protocol: proto,
  type: z.literal('options.request'),
  id: msgId,
  fieldId,
  parentValue: z.string().max(200).nullable(),
  page: z.number().int().min(1).max(100),
  search: z.string().max(200),
});
const optionsResult = z.strictObject({
  protocol: proto,
  type: z.literal('options.result'),
  replyTo: msgId,
  fieldId,
  options: z.array(option).max(500),
  hasMore: z.boolean(),
});
export const LOOKUP_STATUSES = ['ok', 'unknown_lookup', 'forbidden', 'unavailable', 'rate_limited'] as const;
const lookupRequest = z.strictObject({ protocol: proto, type: z.literal('lookup.request'), id: msgId, lookupId, search: z.string().max(100) });
const lookupResult = z.strictObject({
  protocol: proto,
  type: z.literal('lookup.result'),
  replyTo: msgId,
  lookupId,
  status: z.enum(LOOKUP_STATUSES),
  rows: z.array(z.strictObject({ label: z.string().max(200), cells: z.record(fieldId, z.string().max(1000)) })).max(20),
  truncated: z.boolean(),
});
const collect = z.strictObject({ protocol: proto, type: z.literal('collect'), dialogId, req: reqToken });
/** The only message that carries values, once per `req`, on submit. Untouched secret fields are absent. */
const collected = z.strictObject({
  protocol: proto,
  type: z.literal('collected'),
  dialogId,
  req: reqToken,
  valid: z.boolean(),
  errors: z.array(fieldError).max(200),
  values: z.record(fieldId, dmsValue),
  prefillHash: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});
export const BRIDGE_ERROR_CODES = ['unsupported_version', 'invalid_init', 'unsupported_field_type', 'render_failed', 'origin_rejected', 'internal'] as const;
const bridgeError = z.strictObject({ protocol: proto, type: z.literal('error'), code: z.enum(BRIDGE_ERROR_CODES), fatal: z.boolean() });

/** Every `fp-bridge/2` message. `hello` and `port` travel on the window, everything else on the MessagePort. */
export const FpBridgeV2MessageSchema = z.discriminatedUnion('type', [
  hello,
  port,
  init,
  initialized,
  resize,
  state,
  optionsRequest,
  optionsResult,
  lookupRequest,
  lookupResult,
  collect,
  collected,
  bridgeError,
]);
export type FpBridgeV2Message = z.infer<typeof FpBridgeV2MessageSchema>;
export type FpBridgeV2Type = FpBridgeV2Message['type'];

export const BRIDGE_V2_WINDOW_TYPES = ['hello', 'port'] as const satisfies readonly FpBridgeV2Type[];
/** Child -> parent on the port. */
export const BRIDGE_V2_CHILD_TYPES = ['initialized', 'resize', 'state', 'options.request', 'lookup.request', 'collected', 'error'] as const satisfies readonly FpBridgeV2Type[];
/** Parent -> child on the port. */
export const BRIDGE_V2_PARENT_TYPES = ['init', 'options.result', 'lookup.result', 'collect'] as const satisfies readonly FpBridgeV2Type[];
