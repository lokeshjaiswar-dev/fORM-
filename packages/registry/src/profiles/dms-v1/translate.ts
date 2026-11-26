import type { BlockConfigMap, BlockId, ChoiceOption, FieldBlock, FieldKey, FormDefinition, InlineDoc, OptionId, PurposeId, StoredBlock } from '@form/schema';
import { DEFAULT_COMPLIANCE } from '../../compliance.ts';
import { labelText } from '../../util/text.ts';
import { blankDmsDefinition } from './blank.ts';
import { VISIBILITY_KEYS, flagsOfElement } from './visibility.ts';
import { FP_LOOKUP_KEY, lookupOfPicker, readLookups } from './lookup.ts';
import { optionIdOf } from './fnv.ts';
import {
  DMS_DATE_PATTERN, DMS_PHONE_DEFAULTS, INT32_MAX, INT32_MIN, MODELLED_KEYS, PRIMARY_TYPES, X_DMS, charsOf, dmsTypeOf, isFieldBlock, nameOf, patternFor, xDms,
} from './shared.ts';
import { isDmsV1Type, type DmsElement, type DmsOption, type DmsTranslateOptions, type DmsV1Type, type ProfileIssue } from './types.ts';

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
  for (const [k, v] of Object.entries(el)) if (!MODELLED_KEYS.has(k) && !VISIBILITY_KEYS.includes(k)) rest[k] = v;
  /* is_hidden / is_secret are first-class x-dms keys: read as booleans, written back as read (visibility.ts). */
  Object.assign(rest, flagsOfElement(el));
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
  applyLinks(elements, blocks, options.issues);
  const lookups = readLookups(elements, blocks, options.issues);
  const [first, ...later] = base.pages;
  const page = first ?? blankDmsDefinition(options.formId, options.title, options.locale).pages[0]!;
  const { lookups: _baseLookups, ...baseRest } = base;
  return {
    ...baseRest,
    formId: options.formId as FormDefinition['formId'],
    title: options.title,
    blocks,
    pages: [{ ...page, children }, ...later.map((p) => ({ ...p, children: [] }))].slice(0, 1),
    ...(lookups.length > 0 ? { lookups } : {}),
  };
}

/**
 * Second pass: `linkedTo` / `optionParents` on a dropdown element become `dependsOn` / `parentOptionIds`. A parent that is
 * not an earlier dropdown, or an option value that is not in the list, drops that part of the link and says so.
 */
function applyLinks(elements: readonly DmsElement[], blocks: Partial<Record<BlockId, StoredBlock>>, issues: ProfileIssue[] | undefined): void {
  const earlier = new Map<string, BlockId>();
  const byValue = (block: FieldBlock): Map<string, OptionId> => {
    const m = new Map<string, OptionId>();
    for (const o of (block.config as { options: ChoiceOption[] }).options) if (!m.has(o.code ?? labelText(o.label))) m.set(o.code ?? labelText(o.label), o.id);
    return m;
  };
  const report = (el: DmsElement, code: string, message: string) =>
    issues?.push({ severity: 'warning', code, path: `/blocks/${String(el.id)}`, message, blockId: String(el.id) });
  for (const el of elements) {
    const id = String(el.id) as BlockId;
    const block = blocks[id];
    if (block && block.type === 'single_choice' && el.linkedTo !== undefined) {
      const parentKey = typeof el.linkedTo === 'string' ? el.linkedTo.toLowerCase() : '';
      const parentId = earlier.get(parentKey);
      const parent = parentId === undefined ? undefined : blocks[parentId];
      if (parentId === undefined || !parent || parent.type !== 'single_choice') {
        report(el, 'link_parent_unknown', `"${String(el.name)}" is linked to a field that is not an earlier dropdown, so the link is ignored.`);
      } else {
        const own = byValue(block as FieldBlock);
        const theirs = byValue(parent as FieldBlock);
        const links = isRecord(el.optionParents) ? el.optionParents : {};
        const parents = new Map<OptionId, OptionId[]>();
        for (const [childValue, parentValues] of Object.entries(links)) {
          const childId = own.get(childValue);
          if (childId === undefined) { report(el, 'link_option_unknown', `"${String(el.name)}" has link data for the option "${childValue}", which is not in its list.`); continue; }
          const ids: OptionId[] = [];
          for (const pv of Array.isArray(parentValues) ? parentValues : []) {
            const pid = typeof pv === 'string' ? theirs.get(pv) : undefined;
            if (pid === undefined) report(el, 'link_option_unknown', `The option "${childValue}" is linked to "${String(pv)}", which is not an option of the parent.`);
            else if (!ids.includes(pid)) ids.push(pid);
          }
          if (ids.length > 0) parents.set(childId, ids);
        }
        const config = block.config as unknown as { dependsOn?: BlockId; options: ChoiceOption[] };
        config.dependsOn = parentId;
        config.options = config.options.map((o) => (parents.has(o.id) ? { ...o, parentOptionIds: parents.get(o.id)! } : o));
      }
    }
    if (block && block.type === 'single_choice') earlier.set(id.toLowerCase(), id);
  }
}

const optionName = (o: ChoiceOption): string => labelText(o.label);
const optionValue = (o: ChoiceOption): string => o.code ?? labelText(o.label);

/** `dependsOn` / `parentOptionIds` as `linkedTo` / `optionParents` (option VALUES, DMS's option identity). */
function writeLink(el: DmsElement, block: FieldBlock, def: FormDefinition): void {
  const config = block.config as BlockConfigMap['single_choice'];
  const parentId = config.dependsOn;
  if (parentId === undefined) return;
  const parent = def.blocks[parentId];
  if (!parent || parent.type !== 'single_choice') return;
  const valueOfParent = new Map(parent.config.options.map((o) => [o.id as string, optionValue(o)]));
  const optionParents: Record<string, string[]> = {};
  for (const o of config.options) {
    const values = (o.parentOptionIds ?? []).map((p) => valueOfParent.get(p)).filter((v): v is string => v !== undefined);
    if (values.length > 0) optionParents[optionValue(o)] = values;
  }
  el.linkedTo = parentId;
  if (Object.keys(optionParents).length > 0) el.optionParents = optionParents;
}

function blockToElement(block: FieldBlock, type: DmsV1Type, def: FormDefinition): DmsElement {
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
  if (type === 'dropdown') writeLink(el, block, def);
  const lookup = lookupOfPicker(def.lookups, block.id);
  if (lookup && type === 'textinput') el[FP_LOOKUP_KEY] = lookup;
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
      if (type) out.push(blockToElement(block, type, def));
    }
  }
  return out;
}
