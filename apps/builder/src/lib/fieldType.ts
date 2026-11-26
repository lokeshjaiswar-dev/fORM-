import type { FieldBlock } from '@form/schema';

/** What kind of field it is for the respondent: answer it, see it but not change it, or not see it at all. */
export type FieldTypeFlag = 'required' | 'readOnly' | 'concealed';

export const FIELD_TYPE_FLAGS: readonly FieldTypeFlag[] = ['required', 'readOnly', 'concealed'];

/* A type, not an interface, so it passes where a plain record of block changes is expected. */
export type FieldTypePatch = {
  required: boolean;
  readOnly: true | undefined;
  concealed: true | undefined;
};

/**
 * The flags a field gets when its type is `flag` (or none). Required, read-only and hidden exclude one another: a
 * respondent cannot answer a field they cannot change or cannot see, and a hidden field is already out of their reach,
 * so read-only adds nothing to it.
 */
export function fieldTypePatch(flag: FieldTypeFlag | undefined): FieldTypePatch {
  return { required: flag === 'required', readOnly: flag === 'readOnly' || undefined, concealed: flag === 'concealed' || undefined };
}

/** The flags that are on. A form saved before the rule may still have two; the panel shows both until one is picked. */
export function fieldTypeFlags(block: Pick<FieldBlock, 'required' | 'readOnly' | 'concealed'>): FieldTypeFlag[] {
  return FIELD_TYPE_FLAGS.filter((flag) => block[flag] === true);
}

/**
 * Turns a toggle-group change into one field type: the flag just pressed wins and the others go off; releasing the
 * pressed one leaves none (or, for an old form with two on, the one still pressed).
 */
export function nextFieldType(current: readonly FieldTypeFlag[], next: readonly string[]): FieldTypeFlag | undefined {
  const pressed = next.filter((v): v is FieldTypeFlag => (FIELD_TYPE_FLAGS as readonly string[]).includes(v));
  return pressed.find((flag) => !current.includes(flag)) ?? pressed[0];
}
