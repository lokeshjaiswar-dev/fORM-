import type { MigrationNote } from '../v2/migration.ts';

export type NoteCode = MigrationNote['code'];

/**
 * What each note code means, for the builder's import report. A note always names the element it is about
 * (`path`, a JSON pointer into the migrated definition, or into the v1 document for parts that do not survive)
 * and says what happened in `detail`.
 */
export const NOTE_MEANINGS: Readonly<Record<NoteCode, string>> = {
  html_sanitised: 'HTML outside the rich-text allowlist was removed (S1–S4)',
  logic_value_unmatched: 'a logic value matched no option or is not a valid value for its field, so the rule is disabled',
  logic_operator_changed: 'a logic condition was rewritten to an operator with the same meaning',
  logic_rule_disabled: 'a v1 logic rule could not be kept as it was and is disabled or dropped',
  dangling_logic_source: 'a logic rule reads a block that was deleted or has no answer, so it is disabled (B21)',
  password_extracted: 'the form password was taken out of the document, to be hashed by the API (S5)',
  key_generated: 'a field key or an invalid id was generated',
  external_asset_queued: 'an external logo or cover URL was queued for import into the asset store, or dropped (S7)',
  redirect_dropped: 'the redirect URL is not https and was dropped (S6)',
  unsafe_pattern_dropped: 'a validation pattern that is invalid, unsafe or never applied was dropped (B12, B13, S8)',
  empty_trailing_page_removed: 'an empty page, or a trailing page without a question, was removed (B10)',
  duplicate_option_value: 'several options of one field share a value; their codes keep it (B15, B16)',
  clamped: 'a value outside the v2 range or length was clamped or dropped (B28)',
  required_disabled_resolved: 'a field that was both disabled and required is now read-only and optional (B27)',
  default_purpose_added: 'the default purpose was added; the privacy notice needs approval before publish',
  compliance_defaulted: 'fields take the registry default compliance; review it before publish',
  initially_hidden_set: 'a field shown by a rule starts hidden, as in v1',
  aadhaar_truncated: 'an Aadhaar value was cut to its last four digits',
};

/** Collects notes in the order the migration meets them. */
export class Notes {
  readonly list: MigrationNote[] = [];

  add(code: NoteCode, path: string, detail: string): void {
    this.list.push({ code, path, detail });
  }
}
