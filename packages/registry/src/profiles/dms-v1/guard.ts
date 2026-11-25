import { jsonPointer, type FieldBlock, type FormDefinition } from '@form/schema';
import { labelText } from '../../util/text.ts';
import { DMS_DATE_PATTERN, INT32_MAX, INT32_MIN, PHONE_MAX_LENGTH, PHONE_PATTERN, PRIMARY_TYPES, charsOf, dmsTypeOf, isFieldBlock, nameOf, orderedBlocks } from './shared.ts';
import { legacyOfBlock } from './legacy.ts';
import type { DmsV1Type, ProfileIssue } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX = 255;

type Check = (value: unknown, config: Record<string, unknown>) => boolean;
const any: Check = () => true;

/** Per DMS type: the config keys the profile can write, and for each the values it can represent. A key outside this is dropped on save. */
const REPRESENTABLE: Record<DmsV1Type, Record<string, Check>> = {
  textinput: {
    placeholder: any,
    pattern: (v) => charsOf({ pattern: v as { source: string; flags?: '' | 'i' } }).exact,
    preset: (v) => v === 'alphabetic' || v === 'alphanumeric',
  },
  numberinput: {
    placeholder: any,
    display: (v) => v === 'input',
    integerOnly: (v) => v === true,
    allowNegative: (v) => v === true,
    min: (v) => v === INT32_MIN,
    max: (v) => v === INT32_MAX,
  },
  email: { placeholder: any },
  phonenumber: {
    placeholder: any,
    maxLength: (v) => v === PHONE_MAX_LENGTH,
    pattern: (v) => isRecord(v) && v.source === PHONE_PATTERN && !v.flags,
  },
  multilineinput: { placeholder: any, rows: any },
  dropdown: {
    placeholder: any,
    options: any,
    searchable: any,
    preset: any,
    display: (v) => v === 'dropdown',
  },
  date: {
    pattern: (v) => v === DMS_DATE_PATTERN,
    picker: any,
    defaultValue: (v) => isRecord(v) && v.kind === 'today',
  },
};

/** Block-level settings DMS has no place for. */
const UNSUPPORTED_SETTINGS = ['description', 'readOnly', 'concealed', 'initiallyDisabled', 'initiallyHidden', 'messages', 'prefill', 'apiValidation', 'apiOptions'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What stops a definition from being written to DMS (errors) and what the translation would drop (warnings).
 * `DmsMasterRepository.save` calls it before any request and refuses on an error. Every rule here is a rule dms-api
 * enforces or would silently ignore; the server repeats the type rule (T-API G11) so this is a courtesy, not the control.
 */
export function checkDmsV1(def: FormDefinition): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const add = (severity: ProfileIssue['severity'], code: string, path: string, message: string, blockId?: string) =>
    issues.push({ severity, code, path, message, ...(blockId === undefined ? {} : { blockId }) });

  if (def.pages.length > 1) add('error', 'too_many_pages', jsonPointer('pages'), 'A DMS form is one page. Remove the page breaks.');
  const { rules, ruleGroups, variables } = def.logic;
  if (rules.length > 0 || ruleGroups.length > 0 || variables.length > 0) add('error', 'logic_not_supported', jsonPointer('logic'), 'DMS forms have no logic rules or calculations.');

  const blocks = orderedBlocks(def);
  const names = new Map<string, string>();
  let fields = 0;
  let primaries = 0;

  for (const { id, block, placed } of blocks) {
    const at = jsonPointer('blocks', id);
    const type = block.type === 'unsupported' ? null : dmsTypeOf(block);
    if (type === null || !isFieldBlock(block)) {
      const shown = block.type === 'unsupported' ? block.originalType : block.type;
      add('error', 'unsupported_block_type', at, `"${shown}" is not available in DMS forms. DMS offers text, number, email, phone, multi-line, dropdown and date.`, id);
      continue;
    }
    if (!placed) continue;
    fields += 1;
    if (!UUID.test(id)) add('error', 'block_id_not_uuid', jsonPointer('blocks', id, 'id'), 'DMS field ids are UUIDs.', id);
    checkName(block, id, names, add);
    checkLegacy(block, id, add);
    checkPrimary(block, id, type, add, () => (primaries += 1));
    if (type === 'dropdown') checkOptions(block, id, add);
    checkRepresentable(block, id, type, add);
  }
  if (fields === 0 && !blocks.some((b) => b.block.type === 'unsupported')) add('error', 'no_fields', jsonPointer('pages'), 'Add at least one field.');
  if (primaries > 1) add('error', 'multiple_primary', jsonPointer('blocks'), 'Only one field can be the primary key.');
  return issues;
}

type Add = (severity: ProfileIssue['severity'], code: string, path: string, message: string, blockId?: string) => void;

function checkName(block: FieldBlock, id: string, names: Map<string, string>, add: Add): void {
  const name = nameOf(block);
  const at = jsonPointer('blocks', id, 'label');
  if (name === '') return add('error', 'label_empty', at, 'Give every field a name.', id);
  if (name.length > NAME_MAX) add('error', 'label_too_long', at, `A field name is at most ${NAME_MAX} characters.`, id);
  const folded = name.toLowerCase();
  if (names.has(folded)) add('error', 'label_duplicate', at, `Two fields are called "${name}". Field names must be different (capital letters do not count).`, id);
  else names.set(folded, id);
}

/** A converted OpenForm field with no lossless target is read-only: it can be neither required nor the primary key. */
function checkLegacy(block: FieldBlock, id: string, add: Add): void {
  const legacy = legacyOfBlock(block);
  if (!legacy) return;
  if (block.required) add('error', 'LEGACY_READ_ONLY_REQUIRED', jsonPointer('blocks', id, 'required'), `"${nameOf(block)}" was converted from a ${legacy.from} field and is read-only, so it cannot be required.`, id);
  if (block.unique) add('error', 'LEGACY_READ_ONLY_PRIMARY', jsonPointer('blocks', id, 'unique'), `"${nameOf(block)}" was converted from a ${legacy.from} field and is read-only, so it cannot be the primary key.`, id);
}

function checkPrimary(block: FieldBlock, id: string, type: DmsV1Type, add: Add, count: () => void): void {
  if (!block.unique) return;
  count();
  if (!PRIMARY_TYPES.has(type) && !legacyOfBlock(block)) add('error', 'primary_not_allowed', jsonPointer('blocks', id, 'unique'), 'Only a text, number, email or phone field can be the primary key.', id);
}

function checkOptions(block: FieldBlock, id: string, add: Add): void {
  const options = (block.config as { options: Array<{ label: Parameters<typeof labelText>[0]; code?: string }> }).options;
  const at = jsonPointer('blocks', id, 'config', 'options');
  if (options.length === 0) return add('error', 'dropdown_no_options', at, 'A dropdown needs at least one option.', id);
  const seen = new Set<string>();
  options.forEach((o, i) => {
    const name = labelText(o.label).trim();
    const value = (o.code ?? labelText(o.label)).trim();
    if (name === '' || value === '') return add('error', 'option_empty', jsonPointer('blocks', id, 'config', 'options', i), 'Every option needs text.', id);
    if (seen.has(value)) add('error', 'option_duplicate', jsonPointer('blocks', id, 'config', 'options', i), `The option "${value}" appears twice.`, id);
    seen.add(value);
  });
}

function checkRepresentable(block: FieldBlock, id: string, type: DmsV1Type, add: Add): void {
  const allowed = REPRESENTABLE[type];
  const config = block.config as unknown as Record<string, unknown>;
  const dropped = Object.entries(config).filter(([k, v]) => v !== undefined && !(allowed[k]?.(v, config) ?? false)).map(([k]) => k);
  if (dropped.length > 0) add('warning', 'config_dropped', jsonPointer('blocks', id, 'config'), `DMS cannot keep these settings, so they are left out when you save: ${dropped.join(', ')}.`, id);
  const settings = UNSUPPORTED_SETTINGS.filter((k) => (block as unknown as Record<string, unknown>)[k] !== undefined && (block as unknown as Record<string, unknown>)[k] !== false);
  if (settings.length > 0) add('warning', 'settings_dropped', jsonPointer('blocks', id), `DMS cannot keep these field settings, so they are left out when you save: ${settings.join(', ')}.`, id);
}
