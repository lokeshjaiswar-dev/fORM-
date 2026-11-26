import { isDmsV1Type, legacyOfElement, parseDmsDate, parseDmsPhone, type DmsLegacyMarker, type DmsV1Type } from '@form/registry/profiles/dms-v1';
import type { BridgeElementOfInit } from '../bridge/protocolV2.ts';

/*
 * The upload form as DMS sees it: the fields of the doctype then the master, each with its DMS type, and what DMS
 * accepts for it. Nothing here renders. `validateValues` is the child's authority over `valid` (contract
 * fp-bridge/2): the seven types of dms-api's BaseFieldsValidationRule plus classic's own `required` and email check.
 * Values are DMS strings keyed by field id: date `DD-MM-YYYY`, digits for a number or phone, the option value for a
 * dropdown, `""` when empty. A secret field is never prefilled: DMS sends `null` and lists it in `masked` when a value is
 * stored, and the child never holds that value (SEC-DESIGN 5.3).
 */

export type FieldErrorCode = 'required' | 'pattern' | 'too_long' | 'invalid_email' | 'not_a_number' | 'not_integer' | 'below_min' | 'above_max' | 'not_in_options' | 'invalid_date';
export interface FieldError { fieldId: string; code: FieldErrorCode; message: string }
export type BridgeElement = BridgeElementOfInit;

/** What the model needs of an `init` (the fp-bridge/2 message satisfies it; so does the retired /1 payload). */
export interface ModelInput {
  doctypeFields: readonly BridgeElement[];
  masterFields: readonly BridgeElement[];
  readOnly: boolean;
  context: { mode: 'create' | 'edit'; today: string };
  locale: string;
  /** Ids DMS holds a value for but may not show (value `null` in `values`). */
  masked?: readonly string[];
}

export type Section = 'doctype' | 'master';
export interface Option { name: string; value: string }

export interface UploadField {
  id: string;
  /** The field name: the key of the legacy record and the label shown. */
  name: string;
  /** The classic toolbox type as sent; `supported` says whether it is one of the seven. */
  type: string;
  supported: boolean;
  section: Section;
  required: boolean;
  /** An auto-increment text or number field: shown read-only, never in `values`, never validated. */
  increment: boolean;
  /**
   * A field converted from OpenForm with no lossless target (`legacy.readOnly`): shown read-only with the raw stored
   * string from `init.values`, never required, never in `values`, never validated, never reported as changed.
   */
  legacy: DmsLegacyMarker | null;
  /** The element as DMS sent it. */
  element: BridgeElement;
  /** `is_secret`: write-only here; never prefilled, sent back only when the person touched it. */
  secret: boolean;
  /** A secret (or other) field DMS holds a value for that this page may not show; the field starts empty and shows "Stored (hidden)". */
  masked: boolean;
  /** A dropdown whose options come from the parent (none sent, or tied to another field). */
  remoteOptions: boolean;
  /** The id of the dropdown this one depends on, when that field is in the form. */
  parentId: string | null;
}

export interface UploadModel {
  fields: UploadField[];
  byId: ReadonlyMap<string, UploadField>;
  /** Ids of fields outside the seven types; non-empty means the parent must fall back to its own renderer. */
  unsupported: string[];
  readOnly: boolean;
  mode: 'create' | 'edit';
  /** `DD-MM-YYYY`, from the parent. */
  today: string;
  locale: string;
}

export type ModelResult = { ok: true; model: UploadModel } | { ok: false; message: string };

export const STORED_HIDDEN = 'Stored (hidden)';

export function buildModel(init: ModelInput): ModelResult {
  const fields: UploadField[] = [];
  const masked = new Set((init.masked ?? []).map((id) => id.toLowerCase()));
  const byId = new Map<string, UploadField>();
  const add = (element: BridgeElement, section: Section): string | null => {
    const key = element.id.toLowerCase();
    if (byId.has(key)) return `field id ${element.id} appears twice`;
    const supported = isDmsV1Type(element.type);
    const increment = supported && element.increment === true && (element.type === 'textinput' || element.type === 'numberinput');
    const field: UploadField = {
      id: element.id,
      name: element.value,
      type: element.type,
      supported,
      section,
      required: element.required === true && legacyOfElement(element as never) === null,
      increment,
      legacy: legacyOfElement(element as never),
      element,
      secret: element.is_secret === true,
      masked: masked.has(key) && legacyOfElement(element as never) === null,
      remoteOptions: element.type === 'dropdown' && ((element.options ?? []).length === 0 || element.parent_field_id !== undefined),
      parentId: element.type === 'dropdown' && element.parent_field_id !== undefined ? element.parent_field_id : null,
    };
    byId.set(key, field);
    fields.push(field);
    return null;
  };
  for (const [elements, section] of [[init.doctypeFields, 'doctype'], [init.masterFields, 'master']] as const) {
    for (const element of elements) {
      const problem = add(element, section);
      if (problem) return { ok: false, message: problem };
    }
  }
  // A parent id that is not a field of this form is no dependency.
  for (const field of fields) {
    if (field.parentId !== null && !byId.has(field.parentId.toLowerCase())) {
      field.parentId = null;
      field.remoteOptions = (field.element.options ?? []).length === 0;
    }
  }
  return {
    ok: true,
    model: {
      fields,
      byId,
      unsupported: fields.filter((f) => !f.supported).map((f) => f.id),
      readOnly: init.readOnly,
      mode: init.context.mode,
      today: init.context.today,
      locale: init.locale,
    },
  };
}

/** The fields whose value the parent receives. */
export const editableFields = (model: UploadModel): UploadField[] => model.fields.filter((f) => f.supported && !f.increment && f.legacy === null);

/** The stored DMS string for a field in `init.values` (ids compare case-insensitively), `""` when none. */
export function givenValue(given: Readonly<Record<string, string | null>>, id: string): string {
  const key = id.toLowerCase();
  for (const [k, v] of Object.entries(given)) if (k.toLowerCase() === key) return v ?? '';
  return '';
}

/** The field with this id (compared case-insensitively, as a uuid is). */
export const fieldOf = (model: UploadModel, id: string): UploadField | undefined => model.byId.get(id.toLowerCase());

/** `DD-MM-YYYY` when DMS sent a date in either of the two forms it accepts; anything else is kept as sent so it can be reported. */
export function normaliseDate(raw: string): string {
  const iso = parseDmsDate(raw);
  return iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : raw;
}

/**
 * The starting value of every editable field: DMS's value (dates normalised), else today for a "default to today" date, else `""`.
 * A secret or masked field always starts empty, whatever `given` holds: a secret value is never prefilled (SEC-DESIGN 5.3).
 */
export function initialValues(model: UploadModel, given: Readonly<Record<string, string | null>>): Record<string, string> {
  const lower = new Map(Object.entries(given).map(([k, v]) => [k.toLowerCase(), v]));
  const out: Record<string, string> = {};
  for (const field of editableFields(model)) {
    if (field.secret || field.masked) {
      out[field.id] = '';
      continue;
    }
    const raw = lower.get(field.id.toLowerCase()) ?? '';
    out[field.id] = field.type === 'date' ? (raw === '' ? (field.element.isDefaultToDate === true ? model.today : '') : normaliseDate(raw)) : raw;
  }
  return out;
}

/** What an auto-increment field shows: the number DMS will assign (create) or the stored value (edit). */
export function incrementDisplay(model: UploadModel, field: UploadField, given: Readonly<Record<string, string | null>>): string {
  if (model.mode === 'create') {
    const next = field.element.autoIncrementValue;
    return next === null || next === undefined ? '' : String(next);
  }
  return givenValue(given, field.id);
}

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Phone strings: 10 national digits (India) or calling code + number, 15 digits at most (E.164). */
const PHONE_MAX = 15;

type Verdict = { code: FieldErrorCode; message: string } | null;

/** The text rule of BaseFieldsValidationRule::validateTextInput for the field's numeric / specialChars flags. */
function textVerdict(field: UploadField, raw: string): Verdict {
  const numeric = field.element.numeric === true;
  const special = field.element.specialChars === true;
  const bad = (message: string): Verdict => ({ code: 'pattern', message: `${field.name} ${message}` });
  if (!numeric && !special) return /^[a-zA-Z\s]+$/.test(raw) ? null : bad('allows only alphabets');
  if (numeric && !special) return /^[a-zA-Z0-9\s]+$/.test(raw) ? null : bad('does not allow special characters');
  if (!numeric && special) return /[0-9]/.test(raw) ? bad('does not allow numbers') : null;
  return null;
}

function numberVerdict(field: UploadField, raw: string): Verdict {
  const text = raw.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return { code: 'not_a_number', message: `${field.name} must be a number` };
  const n = Number(text);
  if (!Number.isInteger(n) || !/^[+-]?\d+$/.test(text)) return { code: 'not_integer', message: `${field.name} must be a whole number` };
  if (n < INT_MIN) return { code: 'below_min', message: `${field.name} must be at least ${INT_MIN}` };
  if (n > INT_MAX) return { code: 'above_max', message: `${field.name} must be at most ${INT_MAX}` };
  return null;
}

/** One field's verdict on a DMS string. `options` are the dropdown's known options (none known: any value passes, as in dms-api). */
export function validateField(field: UploadField, raw: string, options: readonly Option[]): Verdict {
  if (raw.trim() === '') return field.required ? { code: 'required', message: `${field.name} cannot be empty` } : null;
  switch (field.type as DmsV1Type) {
    case 'textinput':
      return textVerdict(field, raw);
    case 'numberinput':
      return numberVerdict(field, raw);
    case 'email':
      return EMAIL.test(raw) ? null : { code: 'invalid_email', message: `${field.name} is not a valid email` };
    case 'phonenumber':
      if (!/^\d+$/.test(raw)) return { code: 'not_a_number', message: `${field.name} must contain digits only` };
      if (raw.length > PHONE_MAX) return { code: 'too_long', message: `${field.name} can have at most ${PHONE_MAX} digits` };
      return parseDmsPhone(raw) ? null : { code: 'pattern', message: `${field.name} must start with a known country code` };
    case 'multilineinput':
      return null;
    case 'dropdown':
      return options.length === 0 || options.some((o) => o.value === raw) ? null : { code: 'not_in_options', message: `${field.name} is not one of the choices` };
    case 'date':
      return parseDmsDate(raw) ? null : { code: 'invalid_date', message: `${field.name} is not a valid date` };
    default:
      return null;
  }
}

/**
 * Errors in field order (doctype, then master). A read-only form has nothing to fix, so it never reports any. A masked field
 * that the person has not touched (`touched`) holds a stored value this page cannot see: it is never "required" and never judged.
 */
export function validateValues(model: UploadModel, values: Readonly<Record<string, string>>, options: Readonly<Record<string, readonly Option[]>>, touched: ReadonlySet<string> = new Set()): FieldError[] {
  if (model.readOnly) return [];
  const errors: FieldError[] = [];
  for (const field of editableFields(model)) {
    if (field.masked && !touched.has(field.id)) continue;
    const verdict = validateField(field, values[field.id] ?? '', optionsFor(field, options));
    if (verdict) errors.push({ fieldId: field.id, ...verdict });
  }
  return errors;
}

/** The dropdown's options: those loaded from the parent, else those DMS sent with the field. */
export function optionsFor(field: UploadField, loaded: Readonly<Record<string, readonly Option[]>>): readonly Option[] {
  return loaded[field.id] ?? (field.element.options ?? []).map((o) => ({ name: o.name, value: o.value }));
}
