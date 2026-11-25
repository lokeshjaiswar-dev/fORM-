import type { BlockConfigMap, BlockId, ChoiceOption, FieldBlock, FieldKey, FormDefinition, InlineDoc, OptionId, PurposeId, StoredBlock } from '@form/schema';
import { DEFAULT_COMPLIANCE } from '../../compliance.ts';
import { labelText } from '../../util/text.ts';
import { blankDmsDefinition } from './blank.ts';
import { optionIdOf } from './fnv.ts';
import {
  DMS_DATE_PATTERN, DMS_PHONE_DEFAULTS, INT32_MAX, INT32_MIN, MODELLED_KEYS, PRIMARY_TYPES, X_DMS, charsOf, dmsTypeOf, isFieldBlock, nameOf, patternFor, xDms,
} from './shared.ts';
import { isDmsV1Type, type DmsElement, type DmsOption, type DmsTranslateOptions, type DmsV1Type } from './types.ts';

/*
 * fORM- definition <-> DMS `form_builder_fields` (DESIGN section 1). One flat page, canvas order = element order.
 * The written element is the classic element plus the OpenForm mirror keys, so dms-api's master form service and the
 * upload step 2 reader both work from it. Keys fORM- does not model live in the block's `x-dms` and come back as they were.
 */

const inline = (text: string): InlineDoc => ({ type: 'doc', content: [text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }] });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `f_` plus the id without dashes: a stable FieldKey per DMS field id, unique in the form. */
function keyFor(id: string, taken: Set<string>): FieldKey {
  let base = `f_${id.toLowerCase().replace(/[^a-z0-9]+/g, '')}`.slice(0, 60);
  if (base === 'f_') base = 'f_field';
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  taken.add(key);
  return key as FieldKey;
}

const optionsOf = (el: DmsElement): DmsOption[] => {
  const raw = Array.isArray(el.select?.options) ? el.select.options : Array.isArray(el.options) ? el.options : [];
  const out: DmsOption[] = [];
  for (const o of raw as unknown[]) {
    if (!isRecord(o)) continue;
    const value = typeof o.value === 'string' || typeof o.value === 'number' ? String(o.value) : typeof o.name === 'string' ? o.name : null;
    if (value === null) continue;
    out.push({ name: typeof o.name === 'string' ? o.name : value, value });
  }
  return out;
};

type Built = { type: 'short_text' | 'phone' | 'number' | 'email' | 'long_text' | 'single_choice' | 'date'; config: Record<string, unknown> };

function configFor(type: DmsV1Type, el: DmsElement): Built {
  const placeholder = typeof el.placeholder === 'string' && el.placeholder !== '' ? { placeholder: el.placeholder } : {};
  switch (type) {
    case 'textinput': {
      const source = patternFor(el.numeric === true, el.specialChars === true);
      return { type: 'short_text', config: { ...placeholder, ...(source === null ? {} : { pattern: { source } }) } };
    }
    case 'phonenumber':
      return { type: 'phone', config: { ...DMS_PHONE_DEFAULTS, ...placeholder } };
    case 'numberinput':
      return { type: 'number', config: { display: 'input', integerOnly: true, allowNegative: true, min: INT32_MIN, max: INT32_MAX, ...placeholder } };
    case 'email':
      return { type: 'email', config: { ...placeholder } };
    case 'multilineinput':
      return { type: 'long_text', config: { rows: 4, ...placeholder } };
    case 'dropdown': {
      const seen = new Set<string>();
      const options: ChoiceOption[] = [];
      for (const o of optionsOf(el)) {
        let id = optionIdOf(o.value);
        // A repeated value would repeat the id; keep both so the guard can name the duplicate instead of losing one.
        for (let n = 2; seen.has(id); n += 1) id = `${optionIdOf(o.value)}_${n}`;
        seen.add(id);
        options.push({ id: id as OptionId, label: o.name, code: o.value });
      }
      return { type: 'single_choice', config: { display: 'dropdown', searchable: true, options, ...placeholder } };
    }
    case 'date':
      return { type: 'date', config: { pattern: DMS_DATE_PATTERN, picker: 'calendar', ...(el.isDefaultToDate === true ? { defaultValue: { kind: 'today' } } : {}) } };
  }
}

function toBlock(el: DmsElement, purposeId: PurposeId, taken: Set<string>): StoredBlock {
  const id = String(el.id) as BlockId;
  if (!isDmsV1Type(el.type)) return { id, type: 'unsupported', originalType: String(el.type), raw: el };
  const type = el.type;
  const name = String(el.name ?? el.label ?? el.value ?? '');
  const built = configFor(type, el);
  const defaults = DEFAULT_COMPLIANCE[built.type];
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el)) if (!MODELLED_KEYS.has(k)) rest[k] = v;
  return {
    id,
    type: built.type,
    key: keyFor(el.id, taken),
    label: inline(name),
    required: el.required === true,
    compliance: { ...defaults, purposeIds: defaults.classification === 'none' ? [] : [purposeId] },
    config: built.config,
    ...(el.primary === true && PRIMARY_TYPES.has(type) ? { unique: { normalize: 'exact' as const } } : {}),
    x: { [X_DMS]: { type, ...rest } },
  } as unknown as StoredBlock;
}

/** DMS elements as a fORM- definition: one page, a field block per element, an `unsupported` block for a type outside the seven. */
export function elementsToDefinition(elements: readonly DmsElement[], options: DmsTranslateOptions): FormDefinition {
  const base = options.base ?? blankDmsDefinition(options.formId, options.title, options.locale);
  const purposeId = base.privacy.purposes[0]?.id as PurposeId;
  const taken = new Set<string>();
  const blocks: Partial<Record<BlockId, StoredBlock>> = {};
  const children: BlockId[] = [];
  for (const el of elements) {
    const block = toBlock(el, purposeId, taken);
    if (blocks[block.id]) continue; // a repeated id would overwrite its first block; the server refuses duplicate ids anyway
    blocks[block.id] = block;
    children.push(block.id);
  }
  const [first, ...later] = base.pages;
  const page = first ?? blankDmsDefinition(options.formId, options.title, options.locale).pages[0]!;
  return {
    ...base,
    formId: options.formId as FormDefinition['formId'],
    title: options.title,
    blocks,
    pages: [{ ...page, children }, ...later.map((p) => ({ ...p, children: [] }))].slice(0, 1),
  };
}

const optionName = (o: ChoiceOption): string => labelText(o.label);
const optionValue = (o: ChoiceOption): string => o.code ?? labelText(o.label);

function blockToElement(block: FieldBlock, type: DmsV1Type): DmsElement {
  const name = nameOf(block);
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(xDms(block))) if (k !== 'type' && !MODELLED_KEYS.has(k)) rest[k] = v;
  const config = block.config as BlockConfigMap[FieldBlock['type']] & { placeholder?: string };
  const el: DmsElement = {
    ...rest,
    id: block.id,
    type,
    name,
    value: name,
    label: name,
    required: block.required,
    placeholder: typeof config.placeholder === 'string' ? config.placeholder : '',
  };
  if (block.unique && PRIMARY_TYPES.has(type)) el.primary = true;
  if (type === 'textinput') {
    const { numeric, specialChars } = charsOf(config as BlockConfigMap['short_text']);
    el.numeric = numeric;
    el.specialChars = specialChars;
  }
  if (type === 'dropdown') {
    const options = (block.config as BlockConfigMap['single_choice']).options.map((o) => ({ name: optionName(o), value: optionValue(o) }));
    el.options = options;
    el.select = { options: options.map((o) => ({ ...o })) };
  }
  if (type === 'date') el.isDefaultToDate = (block.config as BlockConfigMap['date']).defaultValue?.kind === 'today';
  return el;
}

/** The definition as DMS elements in canvas order. Unsupported blocks go back as they came; blocks outside the seven are left out (`checkDmsV1` refuses them first). */
export function definitionToElements(def: FormDefinition): DmsElement[] {
  const out: DmsElement[] = [];
  for (const page of def.pages) {
    for (const id of page.children) {
      const block = def.blocks[id];
      if (!block) continue;
      if (block.type === 'unsupported') {
        if (isRecord(block.raw)) out.push(block.raw as DmsElement);
        continue;
      }
      if (!isFieldBlock(block)) continue;
      const type = dmsTypeOf(block);
      if (type) out.push(blockToElement(block, type));
    }
  }
  return out;
}
