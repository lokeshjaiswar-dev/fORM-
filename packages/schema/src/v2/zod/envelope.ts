import { z } from 'zod';
import { keyed } from './_util.ts';
import { VALIDATION_ERROR_CODES } from '../envelope.ts';
import { FieldComplianceSchema } from './compliance.ts';
import { BlockIdSchema, ExtensionsSchema, FieldKeySchema, OriginSchema, SafeUrlSchema } from './primitives.ts';
import { ColorValueSchema, InlineDocSchema, RichDocSchema } from './rich-text.ts';

export const BlockLayoutSchema = z.strictObject({
  width: z.enum(['full', 'half', 'third', 'two_thirds']),
  startNewRow: z.boolean().exactOptional(),
  labelAlign: z.enum(['top', 'left', 'right']).exactOptional(),
});

export const BlockStyleSchema = z.strictObject({
  labelColor: ColorValueSchema.exactOptional(),
  inputTextColor: ColorValueSchema.exactOptional(),
  inputBg: ColorValueSchema.exactOptional(),
  borderColor: ColorValueSchema.exactOptional(),
  placeholderColor: ColorValueSchema.exactOptional(),
  labelSizePx: z.number().min(10).max(48).exactOptional(),
  inputSizePx: z.number().min(10).max(32).exactOptional(),
  labelWeight: z.enum(['normal', 'medium', 'semibold', 'bold']).exactOptional(),
  align: z.enum(['left', 'center']).exactOptional(),
});

export const ValidationErrorCodeSchema = z.enum(VALIDATION_ERROR_CODES);
export const FieldMessagesSchema = keyed(z.partialRecord(ValidationErrorCodeSchema, z.string().max(1000)));
export const PrefillConfigSchema = z.strictObject({ urlParam: z.string().min(1).max(64).exactOptional(), lockWhenPrefilled: z.boolean().exactOptional() });
export const UniqueConstraintSchema = z.strictObject({ normalize: z.enum(['exact', 'trim_lower', 'e164', 'digits']), message: z.string().max(1000).exactOptional() });
export const ApiPairSchema = z.strictObject({ key: z.string().min(1).max(64), value: z.string().max(2048) });
export const ApiAuthSchema = z.union([
  z.strictObject({ type: z.literal('bearer'), token: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal('api_key'), header: z.string().min(1).max(64), value: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal('basic'), username: z.string().min(1).max(256), password: z.string().max(256) }),
]);
export const ApiSuccessRuleSchema = z.union([
  z.strictObject({ type: z.literal('boolean'), equals: z.boolean() }),
  z.strictObject({ type: z.literal('number'), equals: z.number().finite() }),
  z.strictObject({ type: z.literal('string'), equals: z.array(z.string().min(1).max(256)).min(1).max(3) }),
]);
export const CredentialRefSchema = z.strictObject({ secretId: z.string().max(36).regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/) });
const apiRequest = {
  url: SafeUrlSchema,
  method: z.enum(['GET', 'POST']).exactOptional(),
  query: z.array(ApiPairSchema).max(32).exactOptional(),
  body: z.array(ApiPairSchema).max(32).exactOptional(),
  auth: ApiAuthSchema.exactOptional(),
  parser: z.enum(['json', 'xml']).exactOptional(),
  credentialRef: CredentialRefSchema.exactOptional(),
};
export const ApiRequestConfigSchema = z.strictObject(apiRequest);
export const ApiValidationSchema = z.strictObject({
  ...apiRequest,
  responseKey: z.string().min(1).max(256).exactOptional(),
  success: ApiSuccessRuleSchema.exactOptional(),
});
export const ApiOptionsSchema = z.strictObject({
  ...apiRequest,
  itemsPath: z.string().max(256).exactOptional(),
  collectionKind: z.enum(['array', 'map']).exactOptional(),
  labelKey: z.string().max(256).exactOptional(),
  valueKey: z.string().max(256).exactOptional(),
});
export const ApiLookupMappingSchema = z.strictObject({
  key: z.string().min(1).max(128),
  fieldId: BlockIdSchema.exactOptional(),
});
export const HttpLookupSchema = z.strictObject({
  ...apiRequest,
  id: z.string().min(1).max(64).exactOptional(),
  source: z.literal('http').exactOptional(),
  name: z.string().min(1).max(80).exactOptional(),
  enabled: z.boolean().exactOptional(),
  itemsPath: z.string().max(256).exactOptional(),
  pickerFieldId: BlockIdSchema.exactOptional(),
  pickerKey: z.string().max(128).exactOptional(),
  mappings: z.array(ApiLookupMappingSchema).max(32).exactOptional(),
  searchParam: z.string().min(1).max(64).exactOptional(),
  minChars: z.number().int().min(0).max(3).exactOptional(),
  maxRows: z.number().int().min(1).max(50).exactOptional(),
});
const DMS_ID = /^[0-9a-fA-F-]{36}$/;
export const DmsLookupMappingSchema = z.strictObject({ key: z.string().max(36).regex(DMS_ID), fieldId: BlockIdSchema });
export const DmsMasterLookupSchema = z.strictObject({
  id: z.string().max(64).regex(/^[A-Za-z0-9_-]{1,64}$/),
  source: z.literal('dms_master'),
  name: z.string().min(1).max(80).exactOptional(),
  enabled: z.boolean().exactOptional(),
  masterId: z.string().max(64).regex(/^[A-Za-z0-9-]{1,64}$/),
  pickerFieldId: BlockIdSchema,
  pickerKey: z.string().max(36).regex(DMS_ID),
  mappings: z.array(DmsLookupMappingSchema).max(16),
  minChars: z.number().int().min(0).max(3).exactOptional(),
  maxRows: z.number().int().min(1).max(20).exactOptional(),
});
export const ApiLookupSchema = z.union([DmsMasterLookupSchema, HttpLookupSchema]);
export const PublicLookupSchema = z.strictObject({
  id: z.string().max(64).regex(/^[A-Za-z0-9_-]{1,64}$/),
  source: z.enum(['http', 'dms_master']),
  name: z.string().min(1).max(80).exactOptional(),
  pickerFieldId: BlockIdSchema,
  pickerKey: z.string().max(128),
  mappings: z.array(z.strictObject({ key: z.string().min(1).max(128), fieldId: BlockIdSchema })).max(32),
  minChars: z.number().int().min(0).max(3),
  maxRows: z.number().int().min(1).max(50),
  masterId: z.string().max(64).regex(/^[A-Za-z0-9-]{1,64}$/).exactOptional(),
});
export const PublicApiOptionsSchema = z.strictObject({ remote: z.literal(true) });
export const PublicApiValidationSchema = z.strictObject({ remote: z.literal(true), message: z.string().max(1000).exactOptional() });

/** Shape of BlockBase<T>. */
export const blockBase = <T extends string>(type: T) => ({
  id: BlockIdSchema,
  type: z.literal(type),
  layout: BlockLayoutSchema.exactOptional(),
  style: BlockStyleSchema.exactOptional(),
  initiallyHidden: z.boolean().exactOptional(),
  className: z.string().regex(/^[A-Za-z_-][A-Za-z0-9_-]{0,63}$/).exactOptional(),
  note: z.string().max(5000).exactOptional(),
  origin: OriginSchema.exactOptional(),
  x: ExtensionsSchema.exactOptional(),
});

/** Shape of FieldBase<T>. */
export const fieldBase = <T extends string>(type: T) => ({
  ...blockBase(type),
  key: FieldKeySchema,
  label: InlineDocSchema,
  hideLabel: z.boolean().exactOptional(),
  description: RichDocSchema.exactOptional(),
  required: z.boolean(),
  readOnly: z.boolean().exactOptional(),
  concealed: z.boolean().exactOptional(),
  initiallyDisabled: z.boolean().exactOptional(),
  autoFocus: z.boolean().exactOptional(),
  messages: FieldMessagesSchema.exactOptional(),
  compliance: FieldComplianceSchema,
  prefill: PrefillConfigSchema.exactOptional(),
  unique: UniqueConstraintSchema.exactOptional(),
  apiValidation: ApiValidationSchema.exactOptional(),
  apiOptions: ApiOptionsSchema.exactOptional(),
});
