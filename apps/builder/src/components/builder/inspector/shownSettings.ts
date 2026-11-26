/**
 * Block settings that are hidden for now, for every field. Set one to true to show it again. Hiding only removes the
 * control: a value a form already holds (a pattern, a uniqueness rule, an API check, privacy options) still applies.
 */
export const SHOWN_SETTINGS = {
  /** Short answer: "Pattern (regular expression)". */
  pattern: false,
  /** Validation: "Must be unique on this form". */
  unique: false,
  /** Validation: "Validate with an API". */
  apiValidation: false,
  /** The "Advanced" section: field key, save as a reusable field, error messages. */
  advanced: false,
  /** The "Privacy" section. */
  privacy: false,
  /** Number: "Display" (input or stepper). New numbers are plain inputs. */
  numberDisplay: false,
  /** Dropdown: "Display" (dropdown, radio buttons or checkboxes, images). A dropdown stays a dropdown. */
  dropdownDisplay: false,
  /** Dropdown: "More options" (show option values, fill a field from the selected option, load options from an API). */
  dropdownMoreOptions: false,
} as const;
