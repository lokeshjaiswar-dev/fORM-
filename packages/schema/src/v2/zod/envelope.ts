import { z } from 'zod';
import { keyed } from './_util.ts';
import { VALIDATION_ERROR_CODES } from '../envelope.ts';
import { FieldComplianceSchema } from './compliance.ts';
import { BlockIdSchema, ExtensionsSchema, FieldKeySchema, OriginSchema } from './primitives.ts';
import { ColorValueSchema, InlineDocSchema, RichDocSchema } from './rich-text.ts';

export const BlockLayoutSchema = z.object({
  width: z.enum(['full', 'half', 'third', 'two_thirds']),
  startNewRow: z.boolean().exactOptional(),
  labelAlign: z.enum(['top', 'left', 'right']).exactOptional(),
});

export const BlockStyleSchema = z.object({
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
export const PrefillConfigSchema = z.object({ urlParam: z.string().min(1).max(64).exactOptional(), lockWhenPrefilled: z.boolean().exactOptional() });
export const UniqueConstraintSchema = z.object({ normalize: z.enum(['exact', 'trim_lower', 'e164', 'digits']), message: z.string().max(1000).exactOptional() });

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
});
