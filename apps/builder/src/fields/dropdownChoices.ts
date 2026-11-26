import type { ChoiceOption } from '@form/schema';

/**
 * DMS+ masters refuse "&" in a dropdown's choices, so a dropdown here never stores one either: typing, pasting and
 * switching a list to a dropdown all drop it. Radio buttons, checkboxes and other lists keep "&".
 */
export const DROPDOWN_FORBIDDEN = '&';

/** Whether `block` is a choice question (single or multiple) shown as a dropdown. */
export const isDropdown = (block: { type: string; config: object }): boolean =>
  (block.type === 'single_choice' || block.type === 'multi_choice') && (block.config as { display?: string }).display === 'dropdown';

const strip = (text: string): string => text.split(DROPDOWN_FORBIDDEN).join('');

/** The options with every "&" taken out of their plain-text labels and codes; unchanged options keep their identity. */
export function withoutForbidden(options: readonly ChoiceOption[]): ChoiceOption[] {
  return options.map((option) => {
    const label = typeof option.label === 'string' && option.label.includes(DROPDOWN_FORBIDDEN) ? strip(option.label) : option.label;
    const code = option.code?.includes(DROPDOWN_FORBIDDEN) ? strip(option.code) : option.code;
    if (label === option.label && code === option.code) return option;
    const next: ChoiceOption = { ...option, label };
    if (code) next.code = code;
    else delete next.code;
    return next;
  });
}
