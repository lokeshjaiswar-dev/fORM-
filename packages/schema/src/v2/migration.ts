import type { AnswerValueMap } from './answers.ts';
import type { FieldRegistry } from './blocks.ts';
import type { ValueFieldType } from './catalogue.ts';
import type { FormDefinition } from './definition.ts';
import type { CountryCode, IsoInstant, Locale, TimeZone } from './ids.ts';
import type { FormOps } from './ops.ts';
import type { InlineNode } from './rich-text.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §18  VERSIONING AND MIGRATION
 * ═════════════════════════════════════════════════════════════════════════ */

export type { AnyFormDocument } from '../migrate/document.ts';

export interface MigrationNote {
  path: string;
  code:
    | 'html_sanitised' | 'logic_value_unmatched' | 'logic_operator_changed' | 'logic_rule_disabled' | 'dangling_logic_source'
    | 'password_extracted' | 'key_generated' | 'external_asset_queued' | 'redirect_dropped' | 'unsafe_pattern_dropped'
    | 'empty_trailing_page_removed' | 'duplicate_option_value' | 'clamped' | 'required_disabled_resolved'
    | 'default_purpose_added' | 'compliance_defaulted' | 'initially_hidden_set' | 'aadhaar_truncated';
  detail: string;
}
export interface MigrationContext {
  idFactory: () => string;           // deterministic in tests
  now: IsoInstant;
  orgDefaults: { locale: Locale; timeZone: TimeZone; country: CountryCode };
  htmlToInline(html: string): InlineNode[];   // allowlist parser; never executes
  htmlToPlain(html: string): string;
  isSafePattern(src: string): boolean;
  registry: Pick<FieldRegistry, ValueFieldType>;
}
export interface V1MigrationResult {
  definition: FormDefinition;
  ops: Pick<FormOps, 'access' | 'retention'>;
  /** Hashed with argon2id by the API immediately; never persisted. */
  plaintextPasswordToHash?: string;
  assetImports: Array<{ target: 'logo' | 'cover'; url: string }>;
  notes: MigrationNote[];
}
export interface MigrationStep<From, To> { from: number; to: number; migrate(doc: From, ctx: MigrationContext): { doc: To; notes: MigrationNote[] } }
export interface AnswerCodec<T extends ValueFieldType> { type: T; upgrade(value: unknown, fromCodecVersion: number): AnswerValueMap[T] }
