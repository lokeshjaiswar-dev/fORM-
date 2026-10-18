import type { BlockType, ValueFieldType } from './catalogue.ts';
import type { FieldCompliance } from './compliance.ts';
import type { BlockId, Extensions, FieldKey } from './ids.ts';
import type { ColorValue, InlineDoc, RichDoc } from './rich-text.ts';
import type { Origin } from './template-primitives.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §5  BLOCK ENVELOPE (PROP-*)
 * ═════════════════════════════════════════════════════════════════════════ */

/** PROP-08/09. Rows are auto-packed; collapses to one column below 640px. */
export interface BlockLayout {
  width: 'full' | 'half' | 'third' | 'two_thirds';
  /** Force a new row even if the block would fit beside the previous one. */
  startNewRow?: boolean;
  labelAlign?: 'top' | 'left' | 'right';
}

/** PROP-14. Tokens preferred. */
export interface BlockStyle {
  labelColor?: ColorValue; inputTextColor?: ColorValue; inputBg?: ColorValue;
  borderColor?: ColorValue; placeholderColor?: ColorValue;
  labelSizePx?: number;  // 10..48
  inputSizePx?: number;  // 10..32
  labelWeight?: 'normal' | 'medium' | 'semibold' | 'bold';
  align?: 'left' | 'center';
}

export interface BlockBase<T extends BlockType> {
  id: BlockId;
  type: T;
  layout?: BlockLayout;
  style?: BlockStyle;
  /**
   * Explicit initial logic state (no implicit "a show rule means hidden"). The builder sets it
   * when an author adds a show rule and shows "Hidden until a rule shows it". Publish warns when
   * true and no show rule targets the block.
   */
  initiallyHidden?: boolean;
  /** DSN-04 scoped CSS hook. */
  className?: string;
  /** Builder-only author note; stripped from the runtime. */
  note?: string;
  origin?: Origin;
  x?: Extensions;
}

export const VALIDATION_ERROR_CODES = [
  'required', 'invalid_format', 'too_short', 'too_long', 'too_few_words', 'too_many_words', 'pattern', 'mask', 'preset',
  'invalid_email', 'email_mismatch', 'email_domain_blocked', 'email_disposable', 'email_not_verified',
  'invalid_phone', 'country_not_allowed', 'invalid_url', 'not_a_number', 'not_integer', 'below_min', 'above_max', 'step',
  'not_in_options', 'too_few_selected', 'too_many_selected', 'other_text_required',
  'invalid_date', 'date_out_of_range', 'date_not_allowed', 'age_out_of_range', 'invalid_time', 'time_out_of_range',
  'file_too_large', 'file_too_small', 'file_type_not_allowed', 'too_many_files', 'too_few_files', 'file_missing', 'file_infected',
  'row_incomplete', 'too_few_rows', 'too_many_rows', 'not_unique', 'slot_unavailable', 'out_of_stock', 'coupon_invalid',
  'payment_required', 'payment_failed', 'amount_changed', 'consent_required', 'captcha_failed', 'blocked_by_rule', 'stale_version',
] as const;
export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[number];
/** VAL-07. Translated as `block:<id>:msg:<code>`. */
export type FieldMessages = Partial<Record<ValidationErrorCode, string>>;

/** PRE-01/03. Effective only when compliance.allowPrefill. Param defaults to `key`; composite `key[part]`. */
export interface PrefillConfig { urlParam?: string; lockWhenPrefilled?: boolean }

/** VAL-11. Server-checked; blind index when encrypted. */
export interface UniqueConstraint { normalize: 'exact' | 'trim_lower' | 'e164' | 'digits'; message?: string }

export interface FieldBase<T extends ValueFieldType> extends BlockBase<T> {
  key: FieldKey;
  label: InlineDoc;
  hideLabel?: boolean;
  description?: RichDoc;            // PROP-02
  /** Static; LOG-10 rules override per evaluation. Must be false for computed types. */
  required: boolean;
  /** PROP-06: shown, kept, submitted, not editable. readOnly+required needs a value source (publish check). */
  readOnly?: boolean;
  /** PROP-07: never rendered, still prefilled / calculated / validated / stored. ≠ logic-hidden (which DROPS the answer). */
  concealed?: boolean;
  /** Initial LOG-11 state; a disabled field's value is not submitted. */
  initiallyDisabled?: boolean;
  autoFocus?: boolean;
  messages?: FieldMessages;
  compliance: FieldCompliance;
  prefill?: PrefillConfig;
  unique?: UniqueConstraint;
}
