import type { ChoiceOption } from '@form/schema';
import type { ProfileName } from '@/embed/launch';

/**
 * DMS+ masters refuse "&" in a dropdown's choices, so a dropdown in the Masters builder (profile dms-v1) never stores
 * one either: typing, pasting and switching a list to a dropdown all drop it. Radio buttons, checkboxes, other lists and
 * every dropdown in the full builder keep "&".
 */
export const DROPDOWN_FORBIDDEN = '&';

/** Whether `block` is a choice question (single or multiple) shown as a dropdown. */
export const isDropdown = (block: { type: string; config: object }): boolean =>
  (block.type === 'single_choice' || block.type === 'multi_choice') && (block.config as { display?: string }).display === 'dropdown';

/** Whether `block` is a dropdown that must not hold "&": a dropdown while the builder runs the Masters profile. */
export const forbidsAmpersand = (profile: ProfileName, block: { type: string; config: object }): boolean => profile === 'dms-v1' && isDropdown(block);

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
