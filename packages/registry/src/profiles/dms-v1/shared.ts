import type { BlockType, FieldBlock, FormDefinition, StoredBlock } from '@form/schema';
import { inlineText } from '../../util/text.ts';
import type { DmsV1Type } from './types.ts';

/** `x-dms` on a block: the classic element's type and every classic key fORM- does not model. */
export const X_DMS = 'x-dms';

/** Classic keys fORM- models itself (as block fields, config or `unique`), so they never travel in `x-dms`. */
export const MODELLED_KEYS: ReadonlySet<string> = new Set([
  'id', 'type', 'name', 'value', 'label', 'required', 'placeholder', 'primary', 'options', 'select', 'numeric', 'specialChars', 'isDefaultToDate', 'autoIncrementValue',
]);

/** Types whose value may be the master's primary key. */
export const PRIMARY_TYPES: ReadonlySet<DmsV1Type> = new Set(['textinput', 'numberinput', 'email', 'phonenumber']);

export const INT32_MIN = '-2147483648';
export const INT32_MAX = '2147483647';
export const DMS_DATE_PATTERN = 'DD-MM-YYYY';
/** The phone block's config for a DMS phonenumber (calling-code picker, India first). */
export const DMS_PHONE_DEFAULTS = { defaultCountry: 'IN', showCountrySelect: true } as const;
/** Legacy shape of a DMS phonenumber (before the real phone block): a 10-digit short_text. Still read, never written. */
export const PHONE_PATTERN = '^[0-9]+$';
export const PHONE_MAX_LENGTH = 10;

/** The four textinput character rules (dms-api BaseFieldsValidationRule) as the regex the renderer enforces; `null` = anything. */
export const TEXT_PATTERNS = {
  'numeric=false,specialChars=false': '^[a-zA-Z\\s]+$',
  'numeric=true,specialChars=false': '^[a-zA-Z0-9\\s]+$',
  'numeric=false,specialChars=true': '^[^0-9]*$',
  'numeric=true,specialChars=true': null,
} as const satisfies Record<string, string | null>;

export function patternFor(numeric: boolean, specialChars: boolean): string | null {
  return TEXT_PATTERNS[`numeric=${numeric},specialChars=${specialChars}` as keyof typeof TEXT_PATTERNS];
}

export interface Chars {
  numeric: boolean;
  specialChars: boolean;
  /** False when the block's pattern or preset is something DMS cannot enforce (it is dropped on save). */
  exact: boolean;
}

/** numeric/specialChars of a short_text config: from its pattern, else its preset, else "anything goes". */
export function charsOf(config: { pattern?: { source: string; flags?: '' | 'i' } | undefined; preset?: string | undefined }): Chars {
  const { pattern, preset } = config;
  if (pattern) {
    if (!pattern.flags) {
      for (const numeric of [false, true]) {
        for (const specialChars of [false, true]) {
          if (patternFor(numeric, specialChars) === pattern.source) return { numeric, specialChars, exact: true };
        }
      }
    }
    return { numeric: true, specialChars: true, exact: false };
  }
  if (preset === 'alphabetic') return { numeric: false, specialChars: false, exact: true };
  if (preset === 'alphanumeric') return { numeric: true, specialChars: false, exact: true };
  return { numeric: true, specialChars: true, exact: preset === undefined };
}

export const isPhoneConfig = (config: { maxLength?: number | undefined; pattern?: { source: string; flags?: '' | 'i' } | undefined }): boolean =>
  config.maxLength === PHONE_MAX_LENGTH && config.pattern?.source === PHONE_PATTERN && !config.pattern.flags;

type Dms = { type?: unknown; [k: string]: unknown };

/** The block's `x-dms` record, if it is one. */
export function xDms(block: StoredBlock): Dms {
  const x = 'x' in block ? (block.x as Record<string, unknown> | undefined) : undefined;
  const v = x?.[X_DMS];
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Dms) : {};
}

/** The DMS type a block is written as, or `null` when it is outside the seven. */
export function dmsTypeOf(block: StoredBlock): DmsV1Type | null {
  switch (block.type) {
    case 'short_text': {
      const declared = xDms(block).type;
      if (declared === 'phonenumber' || declared === 'textinput') return declared;
      return isPhoneConfig(block.config) ? 'phonenumber' : 'textinput';
    }
    case 'phone': return 'phonenumber';
    case 'number': return 'numberinput';
    case 'email': return 'email';
    case 'long_text': return 'multilineinput';
    case 'single_choice': return 'dropdown';
    case 'date': return 'date';
    default: return null;
  }
}

export const isFieldBlock = (block: StoredBlock | undefined): block is FieldBlock => block !== undefined && 'compliance' in block;

/** The blocks of the form in canvas order: every page's children, then any block no page lists. */
export function orderedBlocks(def: FormDefinition): Array<{ id: string; block: StoredBlock; placed: boolean }> {
  const out: Array<{ id: string; block: StoredBlock; placed: boolean }> = [];
  const seen = new Set<string>();
  for (const page of def.pages) {
    for (const id of page.children) {
      const block = def.blocks[id];
      if (block && !seen.has(id)) {
        seen.add(id);
        out.push({ id, block, placed: true });
      }
    }
  }
  for (const [id, block] of Object.entries(def.blocks)) if (block && !seen.has(id)) out.push({ id, block, placed: false });
  return out;
}

/** The field's name in DMS: its label as plain text, trimmed. */
export const nameOf = (block: FieldBlock): string => inlineText(block.label).trim();

export type DmsBlockType = Extract<BlockType, 'short_text' | 'phone' | 'number' | 'email' | 'long_text' | 'single_choice' | 'date'>;
