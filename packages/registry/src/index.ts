import type { AnswerPath, AnswerValueMap, BlockId, FieldBlockOf, FieldRegistry, ScalarValue, ValueFieldType } from '@form/schema';
import type { PlainBlockType, PlainDefinition, ValueDefinition } from './define.ts';
import { date } from './fields/date.ts';
import { divider } from './fields/divider.ts';
import { email } from './fields/email.ts';
import { fileUpload } from './fields/file_upload.ts';
import { heading } from './fields/heading.ts';
import { hidden } from './fields/hidden.ts';
import { linearScale } from './fields/linear_scale.ts';
import { longText } from './fields/long_text.ts';
import { multiChoice } from './fields/multi_choice.ts';
import { nps } from './fields/nps.ts';
import { number } from './fields/number.ts';
import { paragraph } from './fields/paragraph.ts';
import { phone } from './fields/phone.ts';
import { ranking } from './fields/ranking.ts';
import { rating } from './fields/rating.ts';
import { shortText } from './fields/short_text.ts';
import { signature } from './fields/signature.ts';
import { singleChoice } from './fields/single_choice.ts';
import { time } from './fields/time.ts';
import { url } from './fields/url.ts';
import {
  address, appointment, calculation, captcha, consent, context, datetime, fullName, image, matrix, payment, repeatingGroup, section, uniqueId,
} from './stubs.ts';

const VALUE_FIELDS: { readonly [T in ValueFieldType]: ValueDefinition<T> } = {
  short_text: shortText,
  long_text: longText,
  full_name: fullName,
  email,
  phone,
  address,
  number,
  url,
  single_choice: singleChoice,
  multi_choice: multiChoice,
  date,
  datetime,
  time,
  rating,
  linear_scale: linearScale,
  nps,
  ranking,
  matrix,
  repeating_group: repeatingGroup,
  file_upload: fileUpload,
  signature,
  hidden,
  consent,
  payment,
  appointment,
  calculation,
  context,
  unique_id: uniqueId,
};

const PLAIN_BLOCKS: { readonly [T in PlainBlockType]: PlainDefinition<T> } = {
  captcha,
  heading,
  paragraph,
  image,
  divider,
  section,
};

/** FND-03: the single source of type knowledge. A BlockType without an entry does not compile. */
export const REGISTRY: FieldRegistry = { ...VALUE_FIELDS, ...PLAIN_BLOCKS };

/** The registry entry of a value type, with its answer members typed. */
export const valueDefinition = <T extends ValueFieldType>(type: T): ValueDefinition<T> => VALUE_FIELDS[type];

/** Fills the block id into option scalars, which `toScalar` leaves unbound. */
export function bindScalar(scalar: ScalarValue, blockId: BlockId): ScalarValue {
  if (scalar.t === 'option') return { ...scalar, blockId };
  if (scalar.t === 'list') return { ...scalar, items: scalar.items.map((item) => bindScalar(item, blockId)) };
  return scalar;
}

/** The one scalar contract (ADR-0002 §2): `registry.toScalar` for a block's answer, with option scalars bound to the block. */
export const answerScalar = <T extends ValueFieldType>(block: FieldBlockOf<T>, value: AnswerValueMap[T], path?: AnswerPath): ScalarValue =>
  bindScalar(valueDefinition(block.type).toScalar(value, path), block.id);

export { AVAILABLE_TYPES, STUB_AVAILABILITY, availability, isAvailable } from './availability.ts';
export type { AvailableType, Phase, StubType } from './availability.ts';
export { COMPLIANCE_UNDER_REVIEW, DEFAULT_COMPLIANCE } from './compliance.ts';
export { defineBlock, defineField, defineStub, defineStubBlock, headerOf, isBlank } from './define.ts';
export type {
  AnswerCheck, BlockSpec, ConfigCheck, ExportColumn, FieldSpec, PlainBlockType, PlainDefinition, Report, ValueDefinition,
} from './define.ts';
export { acceptsFile } from './fields/file_upload.ts';
export { LONG_TEXT_MAX, wordCount } from './fields/long_text.ts';
export { rankCount } from './fields/ranking.ts';
export { UNBOUND_BLOCK_ID } from './fields/shared.ts';
export { SHORT_TEXT_MAX } from './fields/short_text.ts';
export { DRAFT_DEFAULT_CONFIG_TYPES } from './stubs.ts';
export { DEFAULT_TEXT, PALETTE_LABELS } from './messages.ts';
export { CHOICES_OPS, CHOICE_OPS, FILE_OPS, NUMBER_OPS, PRESENCE_OPS, TEMPORAL_OPS, TEXT_OPS } from './operators.ts';
