import type { FormDefinition } from '../v2/definition.ts';

/** One of the two (or more) source fields that could not be combined. */
export interface MergeSide {
  formId: string;
  formTitle: string;
  blockId: string;
  summary: string;
}

/** A matched label+type pair whose settings cannot live on one field. */
export interface MergeConflict {
  label: string;
  type: string;
  reason: string;
  message: string;
  sides: MergeSide[];
}

/** After a conflict, keep this form's copy of the field as-is. */
export interface MergeResolution {
  label: string;
  type: string;
  chosenFormId: string;
}

export type MergeResult = { ok: true; definition: FormDefinition } | { ok: false; conflicts: MergeConflict[] };

export interface MergeFormInput {
  id: string;
  title: string;
  definition: FormDefinition;
}

export interface MergeOptions {
  newFormId: string;
  title?: string;
  resolutions?: readonly MergeResolution[];
  newId: () => string;
}
