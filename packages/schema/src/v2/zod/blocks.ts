import { z } from 'zod';
import type { ContainerBlockType, ContentBlockType, TransientBlockType, ValueFieldType } from '../catalogue.ts';
import type { PublishIssue, UnsupportedBlock } from '../blocks.ts';
import { keyed, options } from './_util.ts';
import { BLOCK_TYPES } from './catalogue.ts';
import { BLOCK_CONFIG_SCHEMAS } from './config.ts';
import { blockBase, fieldBase } from './envelope.ts';
import { BlockIdSchema } from './primitives.ts';

const fieldBlock = <T extends ValueFieldType>(type: T) => z.object({ ...fieldBase(type), config: BLOCK_CONFIG_SCHEMAS[type] });
const plainBlock = <T extends TransientBlockType | ContentBlockType | ContainerBlockType>(type: T) =>
  z.object({ ...blockBase(type), config: BLOCK_CONFIG_SCHEMAS[type] });

/** Twin of FieldBlockOf<T> per value field type. */
export const FIELD_BLOCK_SCHEMAS = {
  short_text: fieldBlock('short_text'), long_text: fieldBlock('long_text'), full_name: fieldBlock('full_name'), email: fieldBlock('email'),
  phone: fieldBlock('phone'), address: fieldBlock('address'), number: fieldBlock('number'), url: fieldBlock('url'),
  single_choice: fieldBlock('single_choice'), multi_choice: fieldBlock('multi_choice'), date: fieldBlock('date'), datetime: fieldBlock('datetime'),
  time: fieldBlock('time'), rating: fieldBlock('rating'), linear_scale: fieldBlock('linear_scale'), nps: fieldBlock('nps'), ranking: fieldBlock('ranking'),
  matrix: fieldBlock('matrix'), repeating_group: fieldBlock('repeating_group'), file_upload: fieldBlock('file_upload'), signature: fieldBlock('signature'),
  hidden: fieldBlock('hidden'), consent: fieldBlock('consent'), payment: fieldBlock('payment'), appointment: fieldBlock('appointment'),
  calculation: fieldBlock('calculation'), context: fieldBlock('context'), unique_id: fieldBlock('unique_id'),
} as const;
/** Twin of PlainBlockOf<T> per transient, content and container type. */
export const PLAIN_BLOCK_SCHEMAS = {
  captcha: plainBlock('captcha'), heading: plainBlock('heading'), paragraph: plainBlock('paragraph'), image: plainBlock('image'),
  divider: plainBlock('divider'), section: plainBlock('section'),
} as const;
/** Twin of BlockOf<T> for every BlockType. */
export const BLOCK_SCHEMAS = { ...FIELD_BLOCK_SCHEMAS, ...PLAIN_BLOCK_SCHEMAS } as const;

export const FieldBlockSchema = z.discriminatedUnion('type', options(FIELD_BLOCK_SCHEMAS));
export const PlainBlockSchema = z.discriminatedUnion('type', options(PLAIN_BLOCK_SCHEMAS));
export const BlockSchema = z.discriminatedUnion('type', options(BLOCK_SCHEMAS));

export const UnsupportedBlockSchema = z.object({
  id: BlockIdSchema,
  type: z.literal('unsupported'),
  originalType: z.string().min(1).max(64),
  raw: z.unknown(),
});
const KNOWN_TYPES: ReadonlySet<string> = new Set([...BLOCK_TYPES, 'unsupported']);
/** Forward compatibility: a block of a type this reader does not know is kept whole as UnsupportedBlock. */
const unknownBlock = keyed(z.looseObject({ id: BlockIdSchema, type: z.string().min(1).max(64).refine((t) => !KNOWN_TYPES.has(t)) }))
  .transform((raw): UnsupportedBlock => ({ id: raw.id, type: 'unsupported', originalType: raw.type, raw }));
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
] as const satisfies ReadonlyArray<PublishIssue['code']>;
export const PublishIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.enum(PUBLISH_ISSUE_CODES),
  path: z.string(),
  message: z.string(),
  fixUrl: z.string().exactOptional(),
});
