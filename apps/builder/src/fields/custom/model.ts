import { z } from 'zod';
import { AVAILABLE_TYPES, REGISTRY, type AvailableType } from '@form/registry';
import type { BlockConfigMap, SchemaLike } from '@form/schema';

const SKIP = new Set<AvailableType>([
  'repeating_group', 'appointment', 'consent', 'hidden', 'calculation', 'context',
  'nps', 'likert', 'constant_sum', 'maxdiff', 'semantic_differential', 'linear_scale', 'unique_id',
]);

/** Input types the library can wrap: palette types that do not need the open form as context. */
export const CUSTOM_FIELD_TYPES = AVAILABLE_TYPES.filter((type) => REGISTRY[type].kind === 'input' && !SKIP.has(type));

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const isCustomFieldType = (type: string): type is CustomFieldType => (CUSTOM_FIELD_TYPES as readonly string[]).includes(type);

export interface CustomField {
  id: string;
  name: string;
  description?: string;
  icon: string;
  keywords: string[];
  baseType: CustomFieldType;
  config: BlockConfigMap[CustomFieldType];
  required: boolean;
  createdAt: string;
  updatedAt: string;
}

const CustomFieldSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  description: z.string().max(200).optional(),
  icon: z.string().min(1).max(40),
  keywords: z.array(z.string().max(40)).max(20),
  baseType: z.string(),
  config: z.record(z.string(), z.unknown()),
  required: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function parseCustomField(raw: unknown): CustomField | null {
  const parsed = CustomFieldSchema.safeParse(raw);
  if (!parsed.success || !isCustomFieldType(parsed.data.baseType)) return null;
  const config = parseConfig(parsed.data.baseType, parsed.data.config);
  if (!config) return null;
  const { description, ...rest } = parsed.data;
  return {
    ...rest,
    ...(description ? { description } : {}),
    baseType: parsed.data.baseType,
    config,
  };
}

export function parseConfig<T extends CustomFieldType>(type: T, config: unknown): BlockConfigMap[T] | null {
  const parsed = (REGISTRY[type].configSchema as SchemaLike<BlockConfigMap[T]>).safeParse(config);
  return parsed.success ? parsed.data : null;
}

export function defaultCustomConfig<T extends CustomFieldType>(type: T, locale: import('@form/schema').Locale): BlockConfigMap[T] {
  return REGISTRY[type].defaultConfig(locale) as BlockConfigMap[T];
}
