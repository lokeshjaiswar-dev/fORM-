/**
 * `SYSTEM_MESSAGE_KEYS` as specified in docs/platform/02-form-schema-v2.md §12 (with
 * `VALIDATION_ERROR_CODES` spread in). @form/schema owns the constant; i18n is its L0 sibling and
 * cannot import it, so this copy is checked against the en-IN catalogue here and the schema's own
 * constant is checked by the first package allowed to import both (validation, WP-0.09).
 */
export const SPEC_VALIDATION_ERROR_CODES = [
  'required', 'invalid_format', 'too_short', 'too_long', 'too_few_words', 'too_many_words', 'pattern', 'mask', 'preset',
  'invalid_email', 'email_mismatch', 'email_domain_blocked', 'email_disposable', 'email_not_verified',
  'invalid_phone', 'country_not_allowed', 'invalid_url', 'not_a_number', 'not_integer', 'below_min', 'above_max', 'step',
  'not_in_options', 'too_few_selected', 'too_many_selected', 'other_text_required',
  'invalid_date', 'date_out_of_range', 'date_not_allowed', 'age_out_of_range', 'invalid_time', 'time_out_of_range',
  'file_too_large', 'file_too_small', 'file_type_not_allowed', 'too_many_files', 'too_few_files', 'file_missing', 'file_infected',
  'row_incomplete', 'too_few_rows', 'too_many_rows', 'not_unique', 'slot_unavailable', 'out_of_stock', 'coupon_invalid',
  'payment_required', 'payment_failed', 'amount_changed', 'consent_required', 'captcha_failed', 'blocked_by_rule', 'stale_version',
] as const;

export const SPEC_SYSTEM_MESSAGE_KEYS = [
  ...SPEC_VALIDATION_ERROR_CODES,
  'nav.next', 'nav.back', 'nav.submit', 'nav.save_later', 'nav.start', 'select.placeholder', 'select.no_results',
  'other.label', 'other.placeholder', 'file.drop_here', 'signature.clear', 'group.add_row', 'group.remove_row',
  'form.closed', 'form.not_open_yet', 'form.limit_reached', 'form.password_prompt', 'form.already_submitted',
  'resume.continue_or_restart', 'resume.link_sent', 'progress.label',
] as const;
