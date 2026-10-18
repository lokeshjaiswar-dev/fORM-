import type { AnswerValueMap } from './answers.ts';
import type { BlockType, ContainerBlockType, ContentBlockType, TransientBlockType, ValueFieldType } from './catalogue.ts';
import type { FieldCompliance } from './compliance.ts';
import type { BlockConfigMap } from './config.ts';
import type { Capability, FormDefinition } from './definition.ts';
import type { BlockBase, FieldBase } from './envelope.ts';
import type { ScalarValue } from './expr.ts';
import type { TextKey } from './i18n.ts';
import type { BlockId, Locale } from './ids.ts';
import type { LogicOperator } from './logic.ts';
import type { AnswerPath } from './rich-text.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §7  BLOCK UNIONS AND FIELD REGISTRY CONTRACT (FND-03)
 * ═════════════════════════════════════════════════════════════════════════ */

export type FieldBlockOf<T extends ValueFieldType> = FieldBase<T> & { config: BlockConfigMap[T] };
export type PlainBlockOf<T extends TransientBlockType | ContentBlockType | ContainerBlockType> = BlockBase<T> & { config: BlockConfigMap[T] };

export type FieldBlock = { [T in ValueFieldType]: FieldBlockOf<T> }[ValueFieldType];
export type PlainBlock = { [T in TransientBlockType | ContentBlockType | ContainerBlockType]: PlainBlockOf<T> }[TransientBlockType | ContentBlockType | ContainerBlockType];
export type Block = FieldBlock | PlainBlock;
export type BlockOf<T extends BlockType> = Extract<Block, { type: T }>;

/**
 * Forward compatibility: a reader meeting an unknown `type` keeps it as UnsupportedBlock and
 * writes `raw` back unchanged. Renderer skips; publish rejects; capability check fails closed.
 */
export interface UnsupportedBlock { id: BlockId; type: 'unsupported'; originalType: string; raw: unknown }
export type StoredBlock = Block | UnsupportedBlock;

export type ComparableKind = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'time' | 'choice' | 'choices' | 'boolean' | 'file' | 'none';

export interface SchemaLike<T> { safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown } }

/** Palette entry: one registry type can appear several times ("Dropdown", "Radio", "Image choice"). */
export interface PaletteEntry<T extends BlockType> {
  id: string;
  category: 'basic' | 'contact' | 'choice' | 'date_time' | 'rating' | 'media' | 'layout' | 'payments' | 'advanced' | 'compliance' | 'snippets';
  labelKey: string;                   // i18n message id
  icon: string;
  keywords: string[];                 // slash-menu search
  configOverrides: Partial<BlockConfigMap[T]>;
}

export interface PublishIssue {
  severity: 'error' | 'warning';
  code:
    | 'duplicate_id' | 'duplicate_key' | 'dangling_ref' | 'logic_cycle' | 'page_order_violation' | 'operator_type_mismatch'
    | 'expr_type_error' | 'expr_too_large' | 'unsafe_regex' | 'invalid_url_scheme' | 'missing_alt_text'
    | 'required_and_disabled' | 'required_and_readonly_without_source' | 'initially_hidden_never_shown'
    | 'unknown_block_type' | 'missing_capability' | 'translation_stale' | 'consent_not_reviewed'
    | 'payment_not_last_page' | 'multiple_payment_blocks' | 'sensitive_prefill' | 'missing_purpose' | 'purpose_without_consent_item'
    | 'bundled_consent' | 'retention_out_of_range' | 'no_ending' | 'empty_page' | 'custom_css_unsafe'
    | 'template_variable_unresolved' | 'brand_ref_unresolved' | 'lock_violation' | 'template_update_required'
    | 'notice_incomplete' | 'consent_after_consent_fields' | 'sensitive_pipe_in_unsafe_context' | 'recipient_not_declared'
    | 'children_policy_incomplete' | 'data_route_not_permitted' | 'validation_bound_page_order'
    /** I5/I6: rich text outside the allowed AST (node types, limits, single-paragraph InlineDoc). */
    | 'invalid_rich_text';
  path: string;        // JSON pointer
  message: string;
  fixUrl?: string;     // e.g. '/settings/org-profile#privacy_contact'
}

/** The registry is the single source of type knowledge (replaces ~15 hard-coded checks in v1). */
export interface FieldDefinition<T extends BlockType> {
  type: T;
  kind: 'input' | 'computed' | 'transient' | 'content' | 'container';
  capability?: Capability;
  palette: PaletteEntry<T>[];
  configSchema: SchemaLike<BlockConfigMap[T]>;
  defaultConfig(locale: Locale): BlockConfigMap[T];
  /** Registry PII default (CMP-03); authors may raise, never silently lower 'sensitive'. */
  defaultCompliance: T extends ValueFieldType ? FieldCompliance : null;
  answerSchema: T extends ValueFieldType ? (block: BlockOf<T>, state: { required: boolean }) => SchemaLike<AnswerValueMap[T]> : null;
  paths: T extends ValueFieldType ? Readonly<Record<string, ComparableKind>> : Readonly<Record<string, never>>;
  operators: Partial<Record<ComparableKind, readonly LogicOperator[]>>;
  /**
   * Per-type primitive with no block, so option scalars carry an unbound `blockId: ''`. Never called directly:
   * `answerScalar(block, value, path)` (@form/registry) is the one scalar contract (ADR-0002 §2).
   */
  toScalar: T extends ValueFieldType ? (value: AnswerValueMap[T], path?: AnswerPath) => ScalarValue : null;
  isEmpty: T extends ValueFieldType ? (value: AnswerValueMap[T]) => boolean : null;
  translatable(block: BlockOf<T>): TextKey[];
  export: T extends ValueFieldType
    ? { columns(block: BlockOf<T>): Array<{ suffix: string; header: string }>; cells(value: AnswerValueMap[T], block: BlockOf<T>): string[]; text(value: AnswerValueMap[T], block: BlockOf<T>): string }
    : null;
  /** Lockable sub-paths for LockSpec 'content' mode (§17.4). */
  lockableContent(block: BlockOf<T>): string[];
  lint(block: BlockOf<T>, def: FormDefinition): PublishIssue[];
}
/** Adding a BlockType without a registry entry is a compile error. */
export type FieldRegistry = { [T in BlockType]: FieldDefinition<T> };
