/**
 * Form settings tabs hidden for now. Turn one back on here; its settings, and any form that already uses them, are
 * untouched while it is hidden.
 */
export const SHOWN_DESIGN_TABS = {
  /** Rules: show, hide and require questions by condition. */
  logic: false,
  /** Sections: the section navigator and how the current section is marked. */
  sections: false,
  /** API autofill: fill questions from an API lookup. */
  lookup: false,
} as const;
