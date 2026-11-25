import { z } from 'zod';
import type { ContainerBlockType, ContentBlockType, TransientBlockType, ValueFieldType } from '../catalogue.ts';
import type { PublishIssue, UnsupportedBlock } from '../blocks.ts';
import { keyed, options } from './_util.ts';
import { BLOCK_TYPES } from './catalogue.ts';
import { BLOCK_CONFIG_SCHEMAS } from './config.ts';
import { PublicApiOptionsSchema, PublicApiValidationSchema, blockBase, fieldBase } from './envelope.ts';
import { BlockIdSchema } from './primitives.ts';

const fieldBlock = <T extends ValueFieldType>(type: T) => z.strictObject({ ...fieldBase(type), config: BLOCK_CONFIG_SCHEMAS[type] });
const plainBlock = <T extends TransientBlockType | ContentBlockType | ContainerBlockType>(type: T) =>
  z.strictObject({ ...blockBase(type), config: BLOCK_CONFIG_SCHEMAS[type] });

/** Twin of FieldBlockOf<T> per value field type. */
export const FIELD_BLOCK_SCHEMAS = {
  short_text: fieldBlock('short_text'), long_text: fieldBlock('long_text'), full_name: fieldBlock('full_name'), email: fieldBlock('email'),
  phone: fieldBlock('phone'), address: fieldBlock('address'), number: fieldBlock('number'), url: fieldBlock('url'),
  single_choice: fieldBlock('single_choice'), multi_choice: fieldBlock('multi_choice'), date: fieldBlock('date'), date_range: fieldBlock('date_range'), datetime: fieldBlock('datetime'),
  time: fieldBlock('time'), rating: fieldBlock('rating'), linear_scale: fieldBlock('linear_scale'), nps: fieldBlock('nps'), ranking: fieldBlock('ranking'),
  matching: fieldBlock('matching'), likert: fieldBlock('likert'),
  constant_sum: fieldBlock('constant_sum'), maxdiff: fieldBlock('maxdiff'), card_sort: fieldBlock('card_sort'),
  semantic_differential: fieldBlock('semantic_differential'), number_range: fieldBlock('number_range'), schedule_grid: fieldBlock('schedule_grid'),
  matrix: fieldBlock('matrix'), repeating_group: fieldBlock('repeating_group'), dynamic_table: fieldBlock('dynamic_table'), file_upload: fieldBlock('file_upload'), signature: fieldBlock('signature'),
  hidden: fieldBlock('hidden'), consent: fieldBlock('consent'), payment: fieldBlock('payment'), appointment: fieldBlock('appointment'),
  calculation: fieldBlock('calculation'), context: fieldBlock('context'), unique_id: fieldBlock('unique_id'),
} as const;
const publicApi = { apiOptions: PublicApiOptionsSchema.exactOptional(), apiValidation: PublicApiValidationSchema.exactOptional() };
/** The respondent's form of each field block: the API request settings shrink to `remote` markers. */
export const PUBLIC_FIELD_BLOCK_SCHEMAS = {
  short_text: FIELD_BLOCK_SCHEMAS.short_text.extend(publicApi),
  long_text: FIELD_BLOCK_SCHEMAS.long_text.extend(publicApi),
  full_name: FIELD_BLOCK_SCHEMAS.full_name.extend(publicApi),
  email: FIELD_BLOCK_SCHEMAS.email.extend(publicApi),
  phone: FIELD_BLOCK_SCHEMAS.phone.extend(publicApi),
  address: FIELD_BLOCK_SCHEMAS.address.extend(publicApi),
  number: FIELD_BLOCK_SCHEMAS.number.extend(publicApi),
  url: FIELD_BLOCK_SCHEMAS.url.extend(publicApi),
  single_choice: FIELD_BLOCK_SCHEMAS.single_choice.extend(publicApi),
  multi_choice: FIELD_BLOCK_SCHEMAS.multi_choice.extend(publicApi),
  date: FIELD_BLOCK_SCHEMAS.date.extend(publicApi),
  date_range: FIELD_BLOCK_SCHEMAS.date_range.extend(publicApi),
  datetime: FIELD_BLOCK_SCHEMAS.datetime.extend(publicApi),
  time: FIELD_BLOCK_SCHEMAS.time.extend(publicApi),
  rating: FIELD_BLOCK_SCHEMAS.rating.extend(publicApi),
  linear_scale: FIELD_BLOCK_SCHEMAS.linear_scale.extend(publicApi),
  nps: FIELD_BLOCK_SCHEMAS.nps.extend(publicApi),
  ranking: FIELD_BLOCK_SCHEMAS.ranking.extend(publicApi),
  matching: FIELD_BLOCK_SCHEMAS.matching.extend(publicApi),
  likert: FIELD_BLOCK_SCHEMAS.likert.extend(publicApi),
  constant_sum: FIELD_BLOCK_SCHEMAS.constant_sum.extend(publicApi),
  maxdiff: FIELD_BLOCK_SCHEMAS.maxdiff.extend(publicApi),
  card_sort: FIELD_BLOCK_SCHEMAS.card_sort.extend(publicApi),
  semantic_differential: FIELD_BLOCK_SCHEMAS.semantic_differential.extend(publicApi),
  number_range: FIELD_BLOCK_SCHEMAS.number_range.extend(publicApi),
  schedule_grid: FIELD_BLOCK_SCHEMAS.schedule_grid.extend(publicApi),
  matrix: FIELD_BLOCK_SCHEMAS.matrix.extend(publicApi),
  repeating_group: FIELD_BLOCK_SCHEMAS.repeating_group.extend(publicApi),
  dynamic_table: FIELD_BLOCK_SCHEMAS.dynamic_table.extend(publicApi),
  file_upload: FIELD_BLOCK_SCHEMAS.file_upload.extend(publicApi),
  signature: FIELD_BLOCK_SCHEMAS.signature.extend(publicApi),
  hidden: FIELD_BLOCK_SCHEMAS.hidden.extend(publicApi),
  consent: FIELD_BLOCK_SCHEMAS.consent.extend(publicApi),
  payment: FIELD_BLOCK_SCHEMAS.payment.extend(publicApi),
  appointment: FIELD_BLOCK_SCHEMAS.appointment.extend(publicApi),
  calculation: FIELD_BLOCK_SCHEMAS.calculation.extend(publicApi),
  context: FIELD_BLOCK_SCHEMAS.context.extend(publicApi),
  unique_id: FIELD_BLOCK_SCHEMAS.unique_id.extend(publicApi),
} as const;
/** Twin of PlainBlockOf<T> per transient, content and container type. */
export const PLAIN_BLOCK_SCHEMAS = {
  captcha: plainBlock('captcha'), heading: plainBlock('heading'), paragraph: plainBlock('paragraph'), image: plainBlock('image'),
  divider: plainBlock('divider'), section_break: plainBlock('section_break'), section: plainBlock('section'),
} as const;
/** Twin of BlockOf<T> for every BlockType. */
export const BLOCK_SCHEMAS = { ...FIELD_BLOCK_SCHEMAS, ...PLAIN_BLOCK_SCHEMAS } as const;

export const FieldBlockSchema = z.discriminatedUnion('type', options(FIELD_BLOCK_SCHEMAS));
export const PlainBlockSchema = z.discriminatedUnion('type', options(PLAIN_BLOCK_SCHEMAS));
export const BlockSchema = z.discriminatedUnion('type', options(BLOCK_SCHEMAS));

export const UnsupportedBlockSchema = z.strictObject({
  id: BlockIdSchema,
  type: z.literal('unsupported'),
  originalType: z.string().min(1).max(64),
  raw: z.unknown(),
});
const KNOWN_TYPES: ReadonlySet<string> = new Set([...BLOCK_TYPES, 'unsupported']);
/** Forward compatibility: a block of a type this reader does not know is kept whole as UnsupportedBlock. */
const unknownBlock = keyed(z.looseObject({ id: BlockIdSchema, type: z.string().min(1).max(64).refine((t) => !KNOWN_TYPES.has(t)) }))
  .transform((raw): UnsupportedBlock => ({ id: raw.id, type: 'unsupported', originalType: raw.type, raw }));
export const PublicBlockSchema = z.discriminatedUnion('type', options({ ...PUBLIC_FIELD_BLOCK_SCHEMAS, ...PLAIN_BLOCK_SCHEMAS }));
export const PublicStoredBlockSchema = z.union([PublicBlockSchema, UnsupportedBlockSchema, unknownBlock]);
export const StoredBlockSchema = z.union([BlockSchema, UnsupportedBlockSchema, unknownBlock]);

export const ComparableKindSchema = z.enum(['text', 'number', 'money', 'date', 'datetime', 'time', 'choice', 'choices', 'boolean', 'file', 'none']);

export const PUBLISH_ISSUE_CODES = [
  'duplicate_id', 'duplicate_key', 'dangling_ref', 'logic_cycle', 'page_order_violation', 'operator_type_mismatch',
  'expr_type_error', 'expr_too_large', 'unsafe_regex', 'invalid_url_scheme', 'missing_alt_text',
  'required_and_disabled', 'required_and_readonly_without_source', 'initially_hidden_never_shown',
  'unknown_block_type', 'missing_capability', 'translation_stale', 'consent_not_reviewed',
  'payment_not_last_page', 'multiple_payment_blocks', 'sensitive_prefill', 'missing_purpose', 'purpose_without_consent_item',
  'bundled_consent', 'retention_out_of_range', 'no_ending', 'empty_page', 'custom_css_unsafe',
  'template_variable_unresolved', 'brand_ref_unresolved', 'lock_violation', 'template_update_required',
  'notice_incomplete', 'consent_after_consent_fields', 'sensitive_pipe_in_unsafe_context', 'recipient_not_declared',
  'children_policy_incomplete', 'data_route_not_permitted', 'validation_bound_page_order', 'invalid_rich_text',
  'review_unit_empty', 'review_unit_overlap', 'review_unit_contains_payment', 'review_unit_dangling_target',
  'browser_credentials', 'lookup_id_missing', 'lookup_id_duplicate', 'credential_needs_https', 'lookup_mapping_type', 'credential_missing', 'lookup_source_not_allowed',
] as const satisfies ReadonlyArray<PublishIssue['code']>;
export const PublishIssueSchema = z.strictObject({
  severity: z.enum(['error', 'warning']),
  code: z.enum(PUBLISH_ISSUE_CODES),
  path: z.string(),
  message: z.string(),
  fixUrl: z.string().exactOptional(),
});
