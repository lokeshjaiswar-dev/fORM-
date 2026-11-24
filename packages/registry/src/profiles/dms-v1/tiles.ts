import type { BlockType } from '@form/schema';
import { INT32_MAX, INT32_MIN, PHONE_MAX_LENGTH, PHONE_PATTERN, DMS_DATE_PATTERN } from './shared.ts';
import type { DmsV1Type } from './types.ts';

/** One palette tile of the dms-v1 profile: the DMS label and the registry type and config the block starts from. */
export interface DmsV1Tile {
  id: DmsV1Type;
  /** The label DMS+ shows today (classic master toolbox). */
  label: string;
  type: Extract<BlockType, 'short_text' | 'number' | 'email' | 'long_text' | 'single_choice' | 'date'>;
  icon: string;
  keywords: readonly string[];
  configOverrides: Readonly<Record<string, unknown>>;
}

/** Exactly the seven toolbox entries of DMS+, in the toolbox's order. */
export const DMS_V1_TILES: readonly DmsV1Tile[] = [
  { id: 'textinput', label: 'Text Input', type: 'short_text', icon: 'type', keywords: ['text', 'short', 'input', 'line', 'name'], configOverrides: {} },
  { id: 'numberinput', label: 'Number Input', type: 'number', icon: 'hash', keywords: ['number', 'numeric', 'integer', 'count'], configOverrides: { display: 'input', integerOnly: true, allowNegative: true, min: INT32_MIN, max: INT32_MAX } },
  { id: 'email', label: 'Email', type: 'email', icon: 'mail', keywords: ['email', 'mail', 'address'], configOverrides: {} },
  { id: 'phonenumber', label: 'Phone Number', type: 'short_text', icon: 'phone', keywords: ['phone', 'mobile', 'telephone', 'number'], configOverrides: { maxLength: PHONE_MAX_LENGTH, pattern: { source: PHONE_PATTERN } } },
  { id: 'multilineinput', label: 'Multi-line Input', type: 'long_text', icon: 'align-left', keywords: ['multi', 'multiline', 'paragraph', 'long', 'text', 'address'], configOverrides: { rows: 4 } },
  { id: 'dropdown', label: 'Dropdown', type: 'single_choice', icon: 'chevron-down', keywords: ['dropdown', 'select', 'list', 'choice', 'option'], configOverrides: { display: 'dropdown', searchable: true } },
  { id: 'date', label: 'Date', type: 'date', icon: 'calendar', keywords: ['date', 'day', 'calendar'], configOverrides: { pattern: DMS_DATE_PATTERN, picker: 'calendar' } },
];
