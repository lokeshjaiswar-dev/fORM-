import type { ProfileName } from '@/embed/launch';
import { useProfile } from '@/embed/useProfile';

/** Block settings that can be hidden from the panel. Hiding only removes the control: a value a form already holds still applies. */
export interface ShownSettings {
  /** Short answer: "Pattern (regular expression)". */
  pattern: boolean;
  /** Validation: "Must be unique on this form". */
  unique: boolean;
  /** Validation: "Validate with an API". */
  apiValidation: boolean;
  /** The "Advanced" section: field key, save as a reusable field, error messages. */
  advanced: boolean;
  /** The "Privacy" section. */
  privacy: boolean;
  /** Number: "Display" (input or stepper). */
  numberDisplay: boolean;
  /** Dropdown: "Display" (dropdown, radio buttons or checkboxes, images). */
  dropdownDisplay: boolean;
  /** Dropdown: "More options" (show option values, fill a field from the selected option, load options from an API). */
  dropdownMoreOptions: boolean;
}

const ALL: ShownSettings = {
  pattern: true,
  unique: true,
  apiValidation: true,
  advanced: true,
  privacy: true,
  numberDisplay: true,
  dropdownDisplay: true,
  dropdownMoreOptions: true,
};

/**
 * The Masters builder (profile dms-v1) shows the settings DMS can store, in a short panel: no regular expression (DMS
 * keeps only its own character sets), no API check, no field key or custom messages, no display variants and no
 * option sources. "Must be unique" stays: in a master it is the primary key (DESIGN section 2). Privacy is a `full`
 * profile section (BlockInspector). Every other profile shows everything.
 */
const MASTERS: ShownSettings = { ...ALL, pattern: false, apiValidation: false, advanced: false, privacy: false, numberDisplay: false, dropdownDisplay: false, dropdownMoreOptions: false };

export const shownSettings = (profile: ProfileName): ShownSettings => (profile === 'dms-v1' ? MASTERS : ALL);

export const useShownSettings = (): ShownSettings => shownSettings(useProfile());
