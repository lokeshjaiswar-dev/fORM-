import { z } from 'zod';
import { COMPUTED_FIELD_TYPES, CONTAINER_BLOCK_TYPES, CONTENT_BLOCK_TYPES, INPUT_FIELD_TYPES, TRANSIENT_BLOCK_TYPES } from '../catalogue.ts';

export const VALUE_FIELD_TYPES = [...INPUT_FIELD_TYPES, ...COMPUTED_FIELD_TYPES] as const;
export const BLOCK_TYPES = [...VALUE_FIELD_TYPES, ...TRANSIENT_BLOCK_TYPES, ...CONTENT_BLOCK_TYPES, ...CONTAINER_BLOCK_TYPES] as const;
export const REPEATABLE_BLOCK_TYPES = [
  'short_text', 'long_text', 'full_name', 'email', 'phone', 'address', 'number', 'url', 'single_choice', 'multi_choice',
  'date', 'datetime', 'time', 'rating', 'linear_scale', 'nps', 'ranking', 'matrix', 'file_upload', 'signature',
  'calculation', 'heading', 'paragraph', 'divider',
] as const;

export const InputFieldTypeSchema = z.enum(INPUT_FIELD_TYPES);
export const ComputedFieldTypeSchema = z.enum(COMPUTED_FIELD_TYPES);
export const TransientBlockTypeSchema = z.enum(TRANSIENT_BLOCK_TYPES);
export const ContentBlockTypeSchema = z.enum(CONTENT_BLOCK_TYPES);
export const ContainerBlockTypeSchema = z.enum(CONTAINER_BLOCK_TYPES);
export const ValueFieldTypeSchema = z.enum(VALUE_FIELD_TYPES);
export const BlockTypeSchema = z.enum(BLOCK_TYPES);
export const RepeatableBlockTypeSchema = z.enum(REPEATABLE_BLOCK_TYPES);
