/* ═══════════════════════════════════════════════════════════════════════════
 * §4  FIELD TYPE CATALOGUE
 * ═════════════════════════════════════════════════════════════════════════ */

/** Respondent inputs whose answers are stored. */
export const INPUT_FIELD_TYPES = [
  'short_text',      // FLD-01 (v1 text)
  'long_text',       // FLD-02
  'full_name',       // FLD-03
  'email',           // FLD-04
  'phone',           // FLD-05
  'address',         // FLD-06
  'number',          // FLD-07 / FLD-08 (display: stepper)
  'url',             // FLD-09
  'single_choice',   // FLD-10/12/14/15 (display: radio | dropdown | image)
  'multi_choice',    // FLD-11/13/15  (display: checkbox | dropdown | image)
  'date',            // FLD-16/17
  'datetime',        // FLD-18
  'time',            // FLD-19 (range mode)
  'rating',          // FLD-20
  'linear_scale',    // FLD-21
  'nps',             // FLD-22
  'ranking',         // FLD-23
  'matrix',          // FLD-24
  'repeating_group', // FLD-25
  'file_upload',     // FLD-26/27 (capture)
  'signature',       // FLD-28
  'hidden',          // FLD-30
  'consent',         // FLD-36 + CMP-04 (mode: terms | dpdp)
  'payment',         // FLD-34 / PAY-*
  'appointment',     // FLD-35
] as const;
/** System-produced, stored, read-only. */
export const COMPUTED_FIELD_TYPES = ['calculation', 'context', 'unique_id'] as const; // FLD-33/31/32
/** Verified then discarded. */
export const TRANSIENT_BLOCK_TYPES = ['captcha'] as const;                           // FLD-29
export const CONTENT_BLOCK_TYPES = ['heading', 'paragraph', 'image', 'divider'] as const; // FLD-44..47
export const CONTAINER_BLOCK_TYPES = ['section'] as const;                            // FLD-48

export type InputFieldType = (typeof INPUT_FIELD_TYPES)[number];
export type ComputedFieldType = (typeof COMPUTED_FIELD_TYPES)[number];
export type TransientBlockType = (typeof TRANSIENT_BLOCK_TYPES)[number];
export type ContentBlockType = (typeof CONTENT_BLOCK_TYPES)[number];
export type ContainerBlockType = (typeof CONTAINER_BLOCK_TYPES)[number];
/** Carry a value in Answers. */
export type ValueFieldType = InputFieldType | ComputedFieldType;
export type BlockType = ValueFieldType | TransientBlockType | ContentBlockType | ContainerBlockType;

/** Allowed as repeating-group children (no nesting, money, bookings, consent, server-assigned values). */
export type RepeatableBlockType =
  | Exclude<InputFieldType, 'repeating_group' | 'payment' | 'appointment' | 'consent' | 'hidden'>
  | 'calculation' | 'heading' | 'paragraph' | 'divider';
