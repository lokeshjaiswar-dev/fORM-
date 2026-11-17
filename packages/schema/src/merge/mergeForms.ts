import type { FieldBlock, StoredBlock } from '../v2/blocks.ts';
import type { FormDefinition } from '../v2/definition.ts';
import type { Action, Rule } from '../v2/logic.ts';
import type { BlockId, FieldKey, FormId, PageId } from '../v2/ids.ts';
import { combineFields, conflictMessage, summarizeField } from './combine.ts';
import { fieldMatchKey, isFieldBlock, normalizeLabel, parseMatchKey, plainLabelText } from './labels.ts';
import { remapValue, uniqueKey } from './remap.ts';
import type { MergeConflict, MergeFormInput, MergeOptions, MergeResolution, MergeResult, MergeSide } from './types.ts';

const isContainer = (block: StoredBlock | undefined): block is StoredBlock & { type: 'section' | 'repeating_group'; config: { children: BlockId[] } } =>
  block !== undefined && (block.type === 'section' || block.type === 'repeating_group');

/** Fields inside a configurable list belong to each row, not the page, so they must not match page fields. */
function nestedIds(def: FormDefinition): Set<string> {
  const nested = new Set<string>();
  const visit = (id: string) => {
    nested.add(id);
    const block = def.blocks[id as BlockId];
    if (isContainer(block)) block.config.children.forEach(visit);
  };
  for (const block of Object.values(def.blocks)) {
    if (isContainer(block) && block.type === 'repeating_group') block.config.children.forEach(visit);
  }
  return nested;
}

function takenKeys(def: FormDefinition): Set<string> {
  const taken = new Set<string>();
  for (const block of Object.values(def.blocks)) if (isFieldBlock(block)) taken.add(block.key);
  for (const v of def.logic.variables) taken.add(v.key);
  return taken;
}

/** Top-level value fields only: list/section children are not the same question as a field on the page. */
function indexFields(def: FormDefinition, formId: string, formTitle: string): Map<string, Array<{ block: FieldBlock; formId: string; formTitle: string }>> {
  const nested = nestedIds(def);
  const map = new Map<string, Array<{ block: FieldBlock; formId: string; formTitle: string }>>();
  for (const block of Object.values(def.blocks)) {
    if (!isFieldBlock(block) || nested.has(block.id)) continue;
    if (block.type === 'repeating_group') continue;
    const key = fieldMatchKey(block);
    const list = map.get(key) ?? [];
    list.push({ block, formId, formTitle });
    map.set(key, list);
  }
  return map;
}

function side(formId: string, formTitle: string, block: FieldBlock): MergeSide {
  return { formId, formTitle, blockId: block.id, summary: summarizeField(block) };
}

function resolutionFor(resolutions: readonly MergeResolution[] | undefined, matchKey: string): MergeResolution | undefined {
  const { label, type } = parseMatchKey(matchKey);
  return resolutions?.find((r) => normalizeLabel(r.label) === label && r.type === type);
}

function conflict(matchKey: string, reason: string, sides: MergeSide[], displayLabel?: string): MergeConflict {
  const { label, type } = parseMatchKey(matchKey);
  return { label: displayLabel || label, type, reason, message: conflictMessage(reason), sides };
}

function titleOf(inputs: readonly MergeFormInput[], formId: string): string {
  return inputs.find((i) => i.id === formId)?.title ?? '';
}

function collectWriterConflicts(
  def: FormDefinition,
  origin: Map<string, { formId: string; formTitle: string }>,
  blocks: Map<string, FieldBlock>,
): MergeConflict[] {
  const out: MergeConflict[] = [];
  const setValue = new Map<string, Array<{ expr: string; ruleId: string }>>();
  const skipPage = new Map<string, Array<{ to: string; ruleId: string }>>();
  const skipEnd = new Map<string, Array<{ ending: string; ruleId: string }>>();
  const setEnding = new Map<string, Array<{ ending: string; ruleId: string }>>();

  const note = (rule: Rule, action: Action) => {
    if (action.type === 'set_value') {
      const list = setValue.get(action.target) ?? [];
      list.push({ expr: JSON.stringify(action.value), ruleId: rule.id });
      setValue.set(action.target, list);
    }
    if (action.type === 'skip_to_page') {
      const list = skipPage.get(action.from) ?? [];
      list.push({ to: action.to, ruleId: rule.id });
      skipPage.set(action.from, list);
    }
    if (action.type === 'skip_to_end') {
      const list = skipEnd.get(action.from) ?? [];
      list.push({ ending: action.endingId ?? '', ruleId: rule.id });
      skipEnd.set(action.from, list);
    }
    if (action.type === 'set_ending') {
      const list = setEnding.get('form') ?? [];
      list.push({ ending: action.endingId, ruleId: rule.id });
      setEnding.set('form', list);
    }
  };

  for (const rule of def.logic.rules) {
    for (const action of [...rule.then, ...(rule.else ?? [])]) note(rule, action);
  }

  const sidesFor = (ruleIds: string[], block?: FieldBlock): MergeSide[] =>
    ruleIds.map((id) => {
      const o = origin.get(id);
      return { formId: o?.formId ?? '', formTitle: o?.formTitle ?? '', blockId: block?.id ?? '', summary: block ? summarizeField(block) : id };
    });

  for (const [target, writes] of setValue) {
    if (new Set(writes.map((w) => w.expr)).size <= 1) continue;
    const block = blocks.get(target);
    out.push(conflict(block ? fieldMatchKey(block) : '::logic', 'logic.set_value', sidesFor(writes.map((w) => w.ruleId), block)));
  }
  for (const [, writes] of skipPage) {
    if (new Set(writes.map((w) => w.to)).size <= 1) continue;
    out.push(conflict('::logic', 'logic.skip_to_page', sidesFor(writes.map((w) => w.ruleId))));
  }
  for (const [, writes] of skipEnd) {
    if (new Set(writes.map((w) => w.ending)).size <= 1) continue;
    out.push(conflict('::logic', 'logic.skip_to_end', sidesFor(writes.map((w) => w.ruleId))));
  }
  for (const [, writes] of setEnding) {
    if (new Set(writes.map((w) => w.ending)).size <= 1) continue;
    out.push(conflict('::logic', 'logic.set_ending', sidesFor(writes.map((w) => w.ruleId))));
  }
  return out;
}

function mapOptionIds(from: FieldBlock, onto: FieldBlock, map: Map<string, string>): void {
  const left = (from.config as { options?: Array<{ id: string; label: unknown }> }).options;
  const right = (onto.config as { options?: Array<{ id: string; label: unknown }> }).options;
  if (!Array.isArray(left) || !Array.isArray(right)) return;
  const byLabel = new Map(right.map((o) => [normalizeLabel(plainLabelText(o.label as never)), o.id]));
  for (const o of left) {
    const to = byLabel.get(normalizeLabel(plainLabelText(o.label as never)));
    if (to) map.set(o.id, to);
  }
}

function copyTree(
  oldId: BlockId,
  src: FormDefinition,
  base: FormDefinition,
  map: Map<string, string>,
  keys: Set<string>,
  newId: () => string,
  defaultPurpose: string | undefined,
): BlockId | null {
  const block = src.blocks[oldId];
  if (!block) return null;
  const existing = map.get(oldId);
  if (existing && base.blocks[existing as BlockId]) return null;

  const id = (existing ?? newId()) as BlockId;
  map.set(oldId, id);
  const copied = remapValue(structuredClone(block), map) as StoredBlock;
  copied.id = id;
  if (isContainer(block) && isContainer(copied)) {
    copied.config = {
      ...copied.config,
      children: block.config.children
        .map((child) => copyTree(child, src, base, map, keys, newId, defaultPurpose))
        .filter((child): child is BlockId => child !== null),
    };
    if (copied.type === 'repeating_group' && copied.config.children.length === 0) return null;
  }
  if (isFieldBlock(copied)) {
    copied.key = uniqueKey(copied.key, keys) as FieldKey;
    keys.add(copied.key);
    if (defaultPurpose && copied.compliance.classification !== 'none') {
      copied.compliance = { ...copied.compliance, purposeIds: copied.compliance.purposeIds.map((p) => (map.get(p) ?? p) as typeof p) };
    }
  }
  base.blocks[id] = copied;
  return id;
}

/**
 * Merge two or more form definitions. Fields match on normalised plain label + type.
 * Compatible settings are combined; clashes are returned so the caller can pick a side.
 */
export function mergeForms(inputs: readonly MergeFormInput[], options: MergeOptions): MergeResult {
  if (inputs.length < 2) {
    return { ok: false, conflicts: [{ label: '', type: '', reason: 'forms', message: 'Select at least two forms to merge.', sides: [] }] };
  }

  const conflicts: MergeConflict[] = [];
  const resolutions = options.resolutions ?? [];

  for (const input of inputs) {
    const indexed = indexFields(input.definition, input.id, input.title);
    for (const [key, list] of indexed) {
      if (list.length < 2) continue;
      conflicts.push(conflict(key, 'duplicate_in_source', list.map((item) => side(item.formId, item.formTitle, item.block))));
    }
  }
  if (conflicts.length) return { ok: false, conflicts };

  const base = structuredClone(inputs[0]!.definition);
  base.formId = options.newFormId as FormId;
  base.title = options.title?.trim() || inputs.map((i) => i.title.trim() || 'Untitled form').join(' + ');

  const survivors = new Map<string, { blockId: BlockId; formId: string }>();
  for (const [key, list] of indexFields(base, inputs[0]!.id, inputs[0]!.title)) {
    survivors.set(key, { blockId: list[0]!.block.id, formId: inputs[0]!.id });
  }

  const ruleOrigin = new Map<string, { formId: string; formTitle: string }>();
  for (const rule of base.logic.rules) ruleOrigin.set(rule.id, { formId: inputs[0]!.id, formTitle: inputs[0]!.title });

  const defaultPurpose = base.privacy.purposes[0]?.id;

  for (const input of inputs.slice(1)) {
    const src = input.definition;
    const nested = nestedIds(src);
    const map = new Map<string, string>();
    map.set(src.defaultEndingId, base.defaultEndingId);
    for (const ending of src.endings) map.set(ending.id, base.defaultEndingId);
    if (defaultPurpose) for (const purpose of src.privacy.purposes) map.set(purpose.id, defaultPurpose);

    for (const block of Object.values(src.blocks)) {
      if (!block || nested.has(block.id) || !isFieldBlock(block) || block.type === 'repeating_group') continue;
      const key = fieldMatchKey(block);
      const hit = survivors.get(key);
      if (!hit) continue;
      map.set(block.id, hit.blockId);
      const keep = base.blocks[hit.blockId];
      if (!isFieldBlock(keep)) continue;
      const chosen = resolutionFor(resolutions, key);
      if (chosen) {
        const pick = chosen.chosenFormId === input.id ? block : keep;
        const applied = structuredClone(pick);
        applied.id = keep.id;
        applied.key = keep.key;
        if (pick === block) mapOptionIds(keep, pick, map);
        else mapOptionIds(block, keep, map);
        base.blocks[keep.id] = applied;
        continue;
      }
      const combined = combineFields(keep, block);
      if (!combined.ok) {
        conflicts.push(conflict(key, combined.reason, [side(hit.formId, titleOf(inputs, hit.formId), keep), side(input.id, input.title, block)], plainLabelText(keep.label)));
        continue;
      }
      combined.field.id = keep.id;
      combined.field.key = keep.key;
      base.blocks[keep.id] = combined.field;
      for (const [from, to] of combined.optionMap) map.set(from, to);
    }

    for (const page of src.pages) map.set(page.id, options.newId());
    for (const rule of src.logic.rules) map.set(rule.id, options.newId());
    for (const group of src.logic.ruleGroups) map.set(group.id, options.newId());
    for (const variable of src.logic.variables) map.set(variable.id, options.newId());

    const keys = takenKeys(base);
    src.pages.forEach((page, pageIndex) => {
      const kept: BlockId[] = [];
      for (const oldId of page.children) {
        const srcBlock = src.blocks[oldId];
        if (!srcBlock) continue;
        if (isFieldBlock(srcBlock) && srcBlock.type !== 'repeating_group' && !nested.has(srcBlock.id) && survivors.has(fieldMatchKey(srcBlock))) {
          continue;
        }
        const copied = copyTree(oldId, src, base, map, keys, options.newId, defaultPurpose);
        if (!copied) continue;
        kept.push(copied);
        if (isFieldBlock(srcBlock) && srcBlock.type !== 'repeating_group' && !nested.has(srcBlock.id)) {
          survivors.set(fieldMatchKey(srcBlock), { blockId: copied, formId: input.id });
        }
      }
      if (!kept.length) return;
      if (pageIndex === 0) {
        const last = base.pages[base.pages.length - 1];
        if (last) last.children.push(...kept);
        else base.pages.push({ id: options.newId() as PageId, children: kept });
      } else {
        base.pages.push({
          id: (map.get(page.id) ?? options.newId()) as PageId,
          title: page.title ?? input.title,
          children: kept,
        });
      }
    });

    for (const rule of src.logic.rules) {
      const copied = remapValue(structuredClone(rule), map) as Rule;
      copied.id = (map.get(rule.id) ?? copied.id) as Rule['id'];
      base.logic.rules.push(copied);
      ruleOrigin.set(copied.id, { formId: input.id, formTitle: input.title });
    }
  }

  const payments = Object.values(base.blocks).filter((b): b is NonNullable<typeof b> => b !== undefined && b.type === 'payment');
  if (payments.length > 1) {
    const sides = payments.filter(isFieldBlock).map((block) => {
      const owner = [...survivors.values()].find((v) => v.blockId === block.id);
      const input = inputs.find((i) => i.id === owner?.formId) ?? inputs[0]!;
      return side(input.id, input.title, block);
    });
    conflicts.push({
      label: isFieldBlock(payments[0]) ? plainLabelText(payments[0].label) : 'Payment',
      type: 'payment',
      reason: 'payment',
      message: conflictMessage('payment'),
      sides,
    });
  }

  const fieldById = new Map<string, FieldBlock>();
  for (const block of Object.values(base.blocks)) if (isFieldBlock(block)) fieldById.set(block.id, block);
  if (!conflicts.length) conflicts.push(...collectWriterConflicts(base, ruleOrigin, fieldById));

  if (conflicts.length) return { ok: false, conflicts };

  base.pages = base.pages.filter((page) => page.children.length > 0);
  if (!base.pages.length) base.pages = [{ id: options.newId() as PageId, children: [] }];
  return { ok: true, definition: base };
}
