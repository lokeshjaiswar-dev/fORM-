import { z } from 'zod';
import { keyed } from './v2/zod/_util.ts';

/** v1 = apps/builder/src/types/form.ts @ e1be409 (no schemaVersion field). */

export const FIELD_TYPES = [
  'heading', 'heading_2', 'heading_3', 'paragraph', 'divider', 'page_break', 'thank_you',
  'text', 'long_text', 'number', 'email', 'phone', 'url', 'dropdown', 'multiple_choice',
  'checkbox', 'multi_select', 'date', 'time', 'rating', 'linear_scale', 'nps', 'ranking',
  'file_upload', 'signature', 'hidden',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const LOGIC_OPERATORS = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'greater_than', 'less_than', 'answered', 'not_answered', 'is_empty'] as const;
export type LogicOperator = (typeof LOGIC_OPERATORS)[number];

export interface FormBlock {
  id: string; type: FieldType; label: string; placeholder?: string; helpText?: string;
  options?: Array<{ id: string; label: string; value: string }>;
  validation?: { required?: boolean; min?: number; max?: number; pattern?: string; errorMessage?: string };
  logic?: { enabled?: boolean; action?: 'show' | 'hide'; sourceBlockId?: string; operator?: LogicOperator; value?: string };
  customize?: Record<string, unknown>;
  order: number;
}
export interface FormSettings {
  submitButtonText: string; successMessage: string; themeColor: string; backgroundColor: string; textColor: string;
  accentColor: string; font: string; progressBar: boolean; redirectUrl: string; closed: boolean; closedMessage: string;
  password: string; logoUrl: string; coverUrl: string; successAnimation: boolean;
}
export interface FormSchema { id: string; title: string; description: string; blocks: FormBlock[]; settings: FormSettings }

export const FieldTypeSchema = z.enum(FIELD_TYPES);
export const LogicOperatorSchema = z.enum(LOGIC_OPERATORS);
export const FormBlockSchema = z.object({
  id: z.string().min(1),
  type: FieldTypeSchema,
  label: z.string(),
  placeholder: z.string().exactOptional(),
  helpText: z.string().exactOptional(),
  options: z.array(z.object({ id: z.string(), label: z.string(), value: z.string() })).exactOptional(),
  validation: z.object({
    required: z.boolean().exactOptional(),
    min: z.number().exactOptional(),
    max: z.number().exactOptional(),
    pattern: z.string().exactOptional(),
    errorMessage: z.string().exactOptional(),
  }).exactOptional(),
  logic: z.object({
    enabled: z.boolean().exactOptional(),
    action: z.enum(['show', 'hide']).exactOptional(),
    sourceBlockId: z.string().exactOptional(),
    operator: LogicOperatorSchema.exactOptional(),
    value: z.string().exactOptional(),
  }).exactOptional(),
  customize: keyed(z.record(z.string(), z.unknown())).exactOptional(),
  order: z.number(),
});
export const FormSettingsSchema = z.object({
  submitButtonText: z.string(), successMessage: z.string(), themeColor: z.string(), backgroundColor: z.string(), textColor: z.string(),
  accentColor: z.string(), font: z.string(), progressBar: z.boolean(), redirectUrl: z.string(), closed: z.boolean(), closedMessage: z.string(),
  password: z.string(), logoUrl: z.string(), coverUrl: z.string(), successAnimation: z.boolean(),
});
export const FormSchemaSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  blocks: z.array(FormBlockSchema),
  settings: FormSettingsSchema,
});

/** apps/builder defaults at e1be409; used to fill settings missing from old local saves. */
export const DEFAULT_SETTINGS: Readonly<FormSettings> = Object.freeze({
  submitButtonText: 'Submit',
  successMessage: 'Thanks for your response!',
  themeColor: '#111111',
  backgroundColor: '#ffffff',
  textColor: '#111111',
  accentColor: '#2383e2',
  font: 'Inter',
  progressBar: false,
  redirectUrl: '',
  closed: false,
  closedMessage: 'This form is no longer accepting responses.',
  password: '',
  logoUrl: '',
  coverUrl: '',
  successAnimation: true,
});

export interface V1Repair { path: string; reason: 'not_an_object' | 'missing_id' | 'duplicate_id' | 'unknown_type' | 'unknown_key' | 'invalid_value' | 'defaulted' }
export type V1ParseResult =
  | { success: true; data: FormSchema; repairs: V1Repair[] }
  | { success: false; error: string };

export const V1RepairSchema = z.object({
  path: z.string(),
  reason: z.enum(['not_an_object', 'missing_id', 'duplicate_id', 'unknown_type', 'unknown_key', 'invalid_value', 'defaulted']),
});
export const V1ParseResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), data: FormSchemaSchema, repairs: z.array(V1RepairSchema) }),
  z.object({ success: z.literal(false), error: z.string() }),
]);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFieldType = (v: unknown): v is FieldType => typeof v === 'string' && (FIELD_TYPES as readonly string[]).includes(v);
const isOperator = (v: unknown): v is LogicOperator => typeof v === 'string' && (LOGIC_OPERATORS as readonly string[]).includes(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function pick<T>(src: Rec, key: string, ok: (v: unknown) => v is T, path: string, repairs: V1Repair[]): T | undefined {
  if (!(key in src) || src[key] === undefined) return undefined;
  const v = src[key];
  if (ok(v)) return v;
  repairs.push({ path: `${path}/${key}`, reason: 'invalid_value' });
  return undefined;
}

const pointerToken = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
/** Reports every key of `src` that the v1 shape at `path` does not have; parsing then drops it. */
function unknownKeys(src: Rec, known: readonly string[], path: string, repairs: V1Repair[]): void {
  for (const key of Object.keys(src)) if (!known.includes(key)) repairs.push({ path: `${path}/${pointerToken(key)}`, reason: 'unknown_key' });
}
const FORM_KEYS = ['id', 'title', 'description', 'blocks', 'settings'] as const;
const BLOCK_KEYS = ['id', 'type', 'label', 'placeholder', 'helpText', 'options', 'validation', 'logic', 'customize', 'order'] as const;
const OPTION_KEYS = ['id', 'label', 'value'] as const;
const VALIDATION_KEYS = ['required', 'min', 'max', 'pattern', 'errorMessage'] as const;
const LOGIC_KEYS = ['enabled', 'action', 'sourceBlockId', 'operator', 'value'] as const;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isAction = (v: unknown): v is 'show' | 'hide' => v === 'show' || v === 'hide';

function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function parseBlock(raw: unknown, index: number, repairs: V1Repair[]): FormBlock | null {
  const path = `/blocks/${index}`;
  if (!isRec(raw)) {
    repairs.push({ path, reason: 'not_an_object' });
    return null;
  }
  if (typeof raw['id'] !== 'string' || raw['id'] === '') {
    repairs.push({ path: `${path}/id`, reason: 'missing_id' });
    return null;
  }
  if (!isFieldType(raw['type'])) {
    repairs.push({ path: `${path}/type`, reason: 'unknown_type' });
    return null;
  }
  unknownKeys(raw, BLOCK_KEYS, path, repairs);
  const label = typeof raw['label'] === 'string' ? raw['label'] : '';
  if (typeof raw['label'] !== 'string') repairs.push({ path: `${path}/label`, reason: 'defaulted' });
  const order = isNum(raw['order']) ? raw['order'] : index;
  if (!isNum(raw['order'])) repairs.push({ path: `${path}/order`, reason: 'defaulted' });

  const block: FormBlock = { id: raw['id'], type: raw['type'], label, order };
  assign(block, 'placeholder', pick(raw, 'placeholder', isStr, path, repairs));
  assign(block, 'helpText', pick(raw, 'helpText', isStr, path, repairs));

  if (raw['options'] !== undefined) {
    if (Array.isArray(raw['options'])) {
      const options: NonNullable<FormBlock['options']> = [];
      raw['options'].forEach((o, i) => {
        if (isRec(o) && typeof o['id'] === 'string' && typeof o['label'] === 'string') {
          unknownKeys(o, OPTION_KEYS, `${path}/options/${i}`, repairs);
          const value = typeof o['value'] === 'string' ? o['value'] : o['label'];
          options.push({ id: o['id'], label: o['label'], value });
        } else {
          repairs.push({ path: `${path}/options/${i}`, reason: 'invalid_value' });
        }
      });
      block.options = options;
    } else {
      repairs.push({ path: `${path}/options`, reason: 'invalid_value' });
    }
  }

  if (raw['validation'] !== undefined) {
    if (isRec(raw['validation'])) {
      const src = raw['validation'];
      const p = `${path}/validation`;
      unknownKeys(src, VALIDATION_KEYS, p, repairs);
      const validation: NonNullable<FormBlock['validation']> = {};
      assign(validation, 'required', pick(src, 'required', isBool, p, repairs));
      assign(validation, 'min', pick(src, 'min', isNum, p, repairs));
      assign(validation, 'max', pick(src, 'max', isNum, p, repairs));
      assign(validation, 'pattern', pick(src, 'pattern', isStr, p, repairs));
      assign(validation, 'errorMessage', pick(src, 'errorMessage', isStr, p, repairs));
      block.validation = validation;
    } else {
      repairs.push({ path: `${path}/validation`, reason: 'invalid_value' });
    }
  }

  if (raw['logic'] !== undefined) {
    if (isRec(raw['logic'])) {
      const src = raw['logic'];
      const p = `${path}/logic`;
      unknownKeys(src, LOGIC_KEYS, p, repairs);
      const logic: NonNullable<FormBlock['logic']> = {};
      assign(logic, 'enabled', pick(src, 'enabled', isBool, p, repairs));
      assign(logic, 'action', pick(src, 'action', isAction, p, repairs));
      assign(logic, 'sourceBlockId', pick(src, 'sourceBlockId', isStr, p, repairs));
      assign(logic, 'operator', pick(src, 'operator', isOperator, p, repairs));
      assign(logic, 'value', pick(src, 'value', isStr, p, repairs));
      block.logic = logic;
    } else {
      repairs.push({ path: `${path}/logic`, reason: 'invalid_value' });
    }
  }

  if (raw['customize'] !== undefined) {
    if (isRec(raw['customize'])) {
      const customize = raw['customize'];
      if (Object.prototype.hasOwnProperty.call(customize, '__proto__')) repairs.push({ path: `${path}/customize/__proto__`, reason: 'unknown_key' });
      block.customize = Object.fromEntries(Object.entries(customize).filter(([key]) => key !== '__proto__'));
    } else repairs.push({ path: `${path}/customize`, reason: 'invalid_value' });
  }
  return block;
}

function parseSettings(raw: unknown, repairs: V1Repair[]): FormSettings {
  const settings: FormSettings = { ...DEFAULT_SETTINGS };
  if (!isRec(raw)) {
    repairs.push({ path: '/settings', reason: 'defaulted' });
    return settings;
  }
  unknownKeys(raw, Object.keys(DEFAULT_SETTINGS), '/settings', repairs);
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof FormSettings>) {
    const v = raw[key];
    if (v === undefined) {
      repairs.push({ path: `/settings/${key}`, reason: 'defaulted' });
    } else if (typeof v === typeof DEFAULT_SETTINGS[key]) {
      (settings as unknown as Rec)[key] = v;
    } else {
      repairs.push({ path: `/settings/${key}`, reason: 'invalid_value' });
    }
  }
  return settings;
}

/**
 * Lenient reader for v1 documents (local saves, exports, the 5 built-in templates). Unknown
 * keys are dropped (reported as 'unknown_key'; `customize` is free-form and kept whole), wrong-typed optional values are removed, missing settings take the v1
 * defaults, and blocks without a string id or with an unknown type are skipped. Every repair
 * is reported; nothing is guessed silently.
 */
export function parseV1(input: unknown): V1ParseResult {
  if (!isRec(input)) return { success: false, error: 'v1 form must be an object' };
  if ('schemaVersion' in input) return { success: false, error: 'document has a schemaVersion; it is not v1' };
  if (!Array.isArray(input['blocks'])) return { success: false, error: 'v1 form must have a blocks array' };
  const repairs: V1Repair[] = [];
  unknownKeys(input, FORM_KEYS, '', repairs);
  const str = (key: 'id' | 'title' | 'description'): string => {
    const v = input[key];
    if (typeof v === 'string') return v;
    repairs.push({ path: `/${key}`, reason: 'defaulted' });
    return '';
  };
  const seen = new Set<string>();
  const blocks: FormBlock[] = [];
  input['blocks'].forEach((raw, i) => {
    const block = parseBlock(raw, i, repairs);
    if (!block) return;
    if (seen.has(block.id)) {
      repairs.push({ path: `/blocks/${i}/id`, reason: 'duplicate_id' });
      return;
    }
    seen.add(block.id);
    blocks.push(block);
  });
  const form: FormSchema = { id: str('id'), title: str('title'), description: str('description'), blocks, settings: parseSettings(input['settings'], repairs) };
  const checked = FormSchemaSchema.safeParse(form);
  if (!checked.success) return { success: false, error: checked.error.message };
  return { success: true, data: checked.data, repairs };
}
