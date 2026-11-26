import { z } from 'zod';
import { ANSWER_VALUE_SCHEMAS, BLOCK_CONFIG_SCHEMAS, COMPUTED_FIELD_TYPES, canonicalJson, jsonPointer } from '@form/schema';
import type {
  AnswerPath, AnswerValueMap, BlockConfigMap, BlockType, Capability, ComparableKind, ContainerBlockType, ContentBlockType,
  FieldBase, FieldBlockOf, FieldCompliance, FormDefinition, Locale, LogicOperator, PaletteEntry, PlainBlockOf, PublishIssue,
  ScalarValue, SchemaLike, TextKey, TransientBlockType, ValidationErrorCode, ValueFieldType,
} from '@form/schema';
import { DEFAULT_COMPLIANCE } from './compliance.ts';
import { inlineText } from './util/text.ts';

export type PlainBlockType = TransientBlockType | ContentBlockType | ContainerBlockType;
export type Path = Array<string | number>;
export type ExportColumn = { suffix: string; header: string };

/** Reports one answer problem; the zod issue carries the code as its message and `params.code`. */
export type Report = (code: ValidationErrorCode, path?: Path) => void;
export type AnswerCheck<T extends ValueFieldType> = (value: AnswerValueMap[T], block: FieldBlockOf<T>, state: { required: boolean }, report: Report) => void;
export type ConfigCheck<C> = (config: C, report: (message: string, path?: Path) => void) => void;

/**
 * `FieldDefinition<T>` for a value type with its conditional members resolved. `REGISTRY: FieldRegistry`
 * checks each entry against the contract with T concrete.
 */
export interface ValueDefinition<T extends ValueFieldType> {
  type: T;
  kind: 'input' | 'computed';
  capability?: Capability;
  palette: PaletteEntry<T>[];
  configSchema: SchemaLike<BlockConfigMap[T]>;
  defaultConfig(locale: Locale): BlockConfigMap[T];
  defaultCompliance: FieldCompliance;
  answerSchema(block: FieldBlockOf<T>, state: { required: boolean }): SchemaLike<AnswerValueMap[T]>;
  paths: Readonly<Record<string, ComparableKind>>;
  operators: Partial<Record<ComparableKind, readonly LogicOperator[]>>;
  toScalar(value: AnswerValueMap[T], path?: AnswerPath): ScalarValue;
  isEmpty(value: AnswerValueMap[T]): boolean;
  translatable(block: FieldBlockOf<T>): TextKey[];
  export: {
    columns(block: FieldBlockOf<T>): ExportColumn[];
    cells(value: AnswerValueMap[T], block: FieldBlockOf<T>): string[];
    text(value: AnswerValueMap[T], block: FieldBlockOf<T>): string;
  };
  lockableContent(block: FieldBlockOf<T>): string[];
  lint(block: FieldBlockOf<T>, def: FormDefinition): PublishIssue[];
}

/** `FieldDefinition<T>` for a block that carries no answer. */
export interface PlainDefinition<T extends PlainBlockType> {
  type: T;
  kind: 'transient' | 'content' | 'container';
  capability?: Capability;
  palette: PaletteEntry<T>[];
  configSchema: SchemaLike<BlockConfigMap[T]>;
  defaultConfig(locale: Locale): BlockConfigMap[T];
  defaultCompliance: null;
  answerSchema: null;
  paths: Readonly<Record<string, never>>;
  operators: Partial<Record<ComparableKind, readonly LogicOperator[]>>;
  toScalar: null;
  isEmpty: null;
  translatable(block: PlainBlockOf<T>): TextKey[];
  export: null;
  lockableContent(block: PlainBlockOf<T>): string[];
  lint(block: PlainBlockOf<T>, def: FormDefinition): PublishIssue[];
}

export interface FieldSpec<T extends ValueFieldType> {
  type: T;
  kind?: 'input' | 'computed';
  palette: PaletteEntry<T>[];
  defaultConfig(locale: Locale): BlockConfigMap[T];
  /** Cross-field config rules on top of the schema twin. */
  checkConfig?: ConfigCheck<BlockConfigMap[T]>;
  /** Config-dependent answer rules on top of the answer twin (which already enforces I9). */
  checkAnswer?: AnswerCheck<T>;
  paths: Readonly<Record<string, ComparableKind>>;
  operators: Partial<Record<ComparableKind, readonly LogicOperator[]>>;
  toScalar(value: AnswerValueMap[T], path?: AnswerPath): ScalarValue;
  isEmpty(value: AnswerValueMap[T]): boolean;
  /** Defaults to one column named after the label. */
  columns?(block: FieldBlockOf<T>): ExportColumn[];
  cells(value: AnswerValueMap[T], block: FieldBlockOf<T>): string[];
  /** Defaults to the non-empty cells joined by ', '. */
  text?(value: AnswerValueMap[T], block: FieldBlockOf<T>): string;
  /** Text keys beyond label, description and messages. */
  texts?(block: FieldBlockOf<T>): TextKey[];
  /** Lockable paths beyond label and description. */
  content?(block: FieldBlockOf<T>): string[];
  /** The config holds a static value (default) that satisfies a read-only required field. */
  hasDefault?(block: FieldBlockOf<T>): boolean;
  lint?(block: FieldBlockOf<T>, def: FormDefinition): PublishIssue[];
}

export interface BlockSpec<T extends PlainBlockType> {
  type: T;
  kind: 'transient' | 'content' | 'container';
  palette: PaletteEntry<T>[];
  defaultConfig(locale: Locale): BlockConfigMap[T];
  checkConfig?: ConfigCheck<BlockConfigMap[T]>;
  texts(block: PlainBlockOf<T>): TextKey[];
  content(block: PlainBlockOf<T>): string[];
  lint?(block: PlainBlockOf<T>, def: FormDefinition): PublishIssue[];
}

/* The zod twins are proven equal to the contract types in @form/schema (twins.test-d.ts). */
const configTwin = <T extends BlockType>(type: T) => BLOCK_CONFIG_SCHEMAS[type] as unknown as z.ZodType<BlockConfigMap[T]>;
const answerTwin = <T extends ValueFieldType>(type: T) => ANSWER_VALUE_SCHEMAS[type].out.shape.value as unknown as z.ZodType<AnswerValueMap[T]>;

/** Runs `check` only on input the twin accepted, so checks always see well-typed values. */
const checked = <V>(base: z.ZodType<V>, check: (value: V, ctx: z.RefinementCtx) => void): z.ZodType<V> =>
  base.pipe(z.custom<V>().superRefine(check));

function configSchemaOf<T extends BlockType>(type: T, check: ConfigCheck<BlockConfigMap[T]> | undefined): SchemaLike<BlockConfigMap[T]> {
  const base = configTwin(type);
  if (!check) return base;
  return checked(base, (config, ctx) => check(config, (message, path = []) => ctx.addIssue({ code: 'custom', message, path })));
}

export const issue = (code: PublishIssue['code'], path: string, message: string, severity: PublishIssue['severity'] = 'error'): PublishIssue =>
  ({ severity, code, path, message });

export const headerOf = (block: FieldBase<ValueFieldType>): string => inlineText(block.label).trim() || block.key;

const blockKey = (block: { id: string }, part: string): TextKey => `block:${block.id}:${part}`;

/** `block:<id>:<field>` for each listed config string that is set and not blank. */
export function configTexts(block: { id: string; config: object }, fields: readonly string[]): TextKey[] {
  const config = block.config as Readonly<Record<string, unknown>>;
  return fields.filter((f) => typeof config[f] === 'string' && (config[f] as string).trim() !== '').map((f) => blockKey(block, f));
}

function fieldTexts(block: FieldBase<ValueFieldType>): TextKey[] {
  const keys: TextKey[] = [blockKey(block, 'label')];
  if (block.description) keys.push(blockKey(block, 'description'));
  for (const code of Object.keys(block.messages ?? {})) keys.push(blockKey(block, `msg:${code}`));
  return keys;
}

const fieldContent = (block: FieldBase<ValueFieldType>): string[] => (block.description ? ['/label', '/description'] : ['/label']);

type Action = FormDefinition['logic']['rules'][number]['then'][number];

/** Some enabled rule has an action (in `then` or `else`) matching `hit`. */
const anyEnabledAction = (def: FormDefinition, hit: (action: Action) => boolean): boolean =>
  def.logic.rules.some((rule) => rule.enabled && [...rule.then, ...(rule.else ?? [])].some(hit));

const setByRule = (id: FieldBase<ValueFieldType>['id'], def: FormDefinition): boolean =>
  anyEnabledAction(def, (action) => action.type === 'set_value' && action.target === id);

const enabledByRule = (id: FieldBase<ValueFieldType>['id'], def: FormDefinition): boolean =>
  anyEnabledAction(def, (action) => action.type === 'enable' && action.targets.includes(id));

/** B27 and PROP-06: a field that can never receive a value must not be required. */
function fieldLint(block: FieldBase<ValueFieldType>, def: FormDefinition, hasDefault: boolean): PublishIssue[] {
  const issues: PublishIssue[] = [];
  if (!block.required) return issues;
  const at = jsonPointer('blocks', block.id, 'required');
  if (block.initiallyDisabled && !enabledByRule(block.id, def)) {
    issues.push(issue('required_and_disabled', at, 'a required field cannot start disabled: a disabled value is never submitted'));
  }
  if (block.readOnly) {
    const prefilled = block.prefill !== undefined && block.compliance.allowPrefill;
    if (!hasDefault && !prefilled && !setByRule(block.id, def)) {
      issues.push(issue('required_and_readonly_without_source', at, 'a required read-only field needs a default, a prefill or a set_value rule'));
    }
  }
  return issues;
}

export function defineField<T extends ValueFieldType>(spec: FieldSpec<NoInfer<T>> & { type: T }): ValueDefinition<T> {
  const answerBase = answerTwin(spec.type);
  const { checkAnswer, cells } = spec;
  return {
    type: spec.type,
    kind: spec.kind ?? 'input',
    palette: spec.palette,
    configSchema: configSchemaOf(spec.type, spec.checkConfig),
    defaultConfig: spec.defaultConfig,
    defaultCompliance: DEFAULT_COMPLIANCE[spec.type],
    answerSchema: (block, state) => {
      if (!checkAnswer) return answerBase;
      return checked(answerBase, (value, ctx) =>
        checkAnswer(value, block, state, (code, path = []) => ctx.addIssue({ code: 'custom', message: code, path, params: { code } })));
    },
    paths: spec.paths,
    operators: spec.operators,
    toScalar: spec.toScalar,
    isEmpty: spec.isEmpty,
    translatable: (block) => [...fieldTexts(block), ...(spec.texts?.(block) ?? [])],
    export: {
      columns: spec.columns ?? ((block) => [{ suffix: '', header: headerOf(block) }]),
      cells,
      text: spec.text ?? ((value, block) => cells(value, block).filter((c) => c !== '').join(', ')),
    },
    lockableContent: (block) => [...fieldContent(block), ...(spec.content?.(block) ?? [])],
    lint: (block, def) => [...fieldLint(block, def, spec.hasDefault?.(block) ?? false), ...(spec.lint?.(block, def) ?? [])],
  };
}

export function defineBlock<T extends PlainBlockType>(spec: BlockSpec<NoInfer<T>> & { type: T }): PlainDefinition<T> {
  return {
    type: spec.type,
    kind: spec.kind,
    palette: spec.palette,
    configSchema: configSchemaOf(spec.type, spec.checkConfig),
    defaultConfig: spec.defaultConfig,
    defaultCompliance: null,
    answerSchema: null,
    paths: {},
    operators: {},
    toScalar: null,
    isEmpty: null,
    translatable: spec.texts,
    export: null,
    lockableContent: spec.content,
    lint: (block, def) => spec.lint?.(block, def) ?? [],
  };
}

/** I9 for any shape: nothing, '', an empty list, or an object whose values are all blank. */
export function isBlank(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.values(value).every(isBlank);
  return false;
}

const missingCapability = (type: BlockType, capability: Capability) => (block: { id: string }): PublishIssue[] => [
  issue('missing_capability', jsonPointer('blocks', block.id), `'${type}' blocks need '${capability}', which this version does not provide yet`),
];

/** Twin parse of the tagged answer, so recursive shapes keep their depth guard. */
function stubAnswerSchema<T extends ValueFieldType>(type: T): SchemaLike<AnswerValueMap[T]> {
  const tagged = ANSWER_VALUE_SCHEMAS[type] as unknown as z.ZodType<{ type: T; value: AnswerValueMap[T] }>;
  return {
    safeParse(input) {
      const parsed = tagged.safeParse({ type, value: input });
      return parsed.success ? { success: true, data: parsed.data.value } : { success: false, error: parsed.error };
    },
  };
}

/**
 * A type whose behaviour lands in a later phase: the real config schema and a valid default config, no
 * palette entry, no operators, and a `missing_capability` lint so compile refuses any form using it.
 * `isEmpty` defaults to `isBlank`; shapes with a non-blank envelope (a matrix `mode`, a payment `currency`)
 * pass their own so it stays true exactly for the values the twin rejects as unanswered (I9).
 */
export function defineStub<T extends ValueFieldType>(
  type: T,
  capability: Capability,
  defaultConfig: (locale: Locale) => BlockConfigMap[T],
  isEmpty: (value: AnswerValueMap[T]) => boolean = isBlank,
): ValueDefinition<T> {
  const answer = stubAnswerSchema(type);
  return {
    type,
    kind: (COMPUTED_FIELD_TYPES as readonly ValueFieldType[]).includes(type) ? 'computed' : 'input',
    capability,
    palette: [],
    configSchema: configTwin(type),
    defaultConfig,
    defaultCompliance: DEFAULT_COMPLIANCE[type],
    answerSchema: () => answer,
    paths: {},
    operators: {},
    toScalar: () => ({ t: 'null' }),
    isEmpty,
    translatable: fieldTexts,
    export: {
      columns: (block) => [{ suffix: '', header: headerOf(block) }],
      cells: (value) => [canonicalJson(value)],
      text: (value) => canonicalJson(value),
    },
    lockableContent: (block) => [...fieldContent(block), '/config'],
    lint: missingCapability(type, capability),
  };
}

export function defineStubBlock<T extends PlainBlockType>(
  type: T,
  kind: PlainDefinition<T>['kind'],
  capability: Capability,
  defaultConfig: (locale: Locale) => BlockConfigMap[T],
): PlainDefinition<T> {
  return {
    type,
    kind,
    capability,
    palette: [],
    configSchema: configTwin(type),
    defaultConfig,
    defaultCompliance: null,
    answerSchema: null,
    paths: {},
    operators: {},
    toScalar: null,
    isEmpty: null,
    translatable: () => [],
    export: null,
    lockableContent: () => ['/config'],
    lint: missingCapability(type, capability),
  };
}
