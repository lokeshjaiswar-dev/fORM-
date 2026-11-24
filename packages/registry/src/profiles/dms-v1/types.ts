import type { FormDefinition } from '@form/schema';

/*
 * Profile `dms-v1` (demo 1, DESIGN.md sections 1 and 2): fORM- running inside DMS+ offers exactly the seven field
 * types DMS+ supports today and writes them in the DMS (classic + OpenForm mirror) dialect.
 */

/** The seven classic toolbox names, which are also dms-api's canonical field types. */
export const DMS_V1_TYPES = ['textinput', 'numberinput', 'email', 'phonenumber', 'multilineinput', 'dropdown', 'date'] as const;
export type DmsV1Type = (typeof DMS_V1_TYPES)[number];

export const isDmsV1Type = (type: unknown): type is DmsV1Type => typeof type === 'string' && (DMS_V1_TYPES as readonly string[]).includes(type);

export interface DmsOption {
  name: string;
  value: string;
}

/** One `form_builder_fields` element. Keys fORM- does not model travel in `x-dms` and come back unchanged. */
export interface DmsElement {
  id: string;
  type: string;
  name: string;
  value?: string;
  label?: string;
  required?: boolean;
  placeholder?: string;
  primary?: boolean;
  numeric?: boolean;
  specialChars?: boolean;
  increment?: boolean;
  incrementOption?: string;
  prefix?: string;
  suffix?: string;
  autoIncrementPattern?: string;
  autoIncrementValue?: unknown;
  isDefaultToDate?: boolean;
  options?: DmsOption[];
  select?: { options: DmsOption[] };
  parent_field_id?: string;
  [extra: string]: unknown;
}

export interface ProfileIssue {
  severity: 'error' | 'warning';
  code: string;
  /** JSON pointer into the definition. */
  path: string;
  message: string;
  blockId?: string;
}

export interface DmsTranslateOptions {
  formId: string;
  title: string;
  locale: string;
  /** A definition to take everything but the blocks and the first page from (the builder passes `blankDefinition`). */
  base?: FormDefinition;
}
