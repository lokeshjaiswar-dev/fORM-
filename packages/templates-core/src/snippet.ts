import { canonicalJson, contentHash } from '@form/schema';
import type {
  Block, BlockId, DocumentOp, FieldKey, FormDefinition, InsertSnippet, InsertSnippetResult, Locale, PageId, Purpose, SnippetTemplatePayload, StoredBlock,
  TemplateVersion, TemplateWarning, TextKey, TranslationEntry,
} from '@form/schema';
import { TemplateCoreError } from './errors.ts';
import { cloneJson, isRec, mapKey, remapRefs, remapTextKey, type Rec } from './remap.ts';
import { Baker, IdAllocator, OFFLINE_ACTOR, binding, conditionIds, origin, sensitiveWarning, uniqueKey, type EngineOptions } from './shared.ts';
import { seedNamespace, uuidv5 } from './uuid.ts';
import { variableNames } from './variables.ts';

type Parent = { pageId: PageId } | { blockId: BlockId };

const childrenOf = (block: StoredBlock | undefined): readonly BlockId[] =>
  block && (block.type === 'section' || block.type === 'repeating_group') ? block.config.children : [];

/** The page or container that lists `blockId`, and its position there. */
function placementOf(form: FormDefinition, blockId: BlockId): { parent: Parent; index: number } | null {
  for (const page of form.pages) {
    const i = page.children.indexOf(blockId);
    if (i >= 0) return { parent: { pageId: page.id }, index: i };
  }
  for (const [id, block] of Object.entries(form.blocks)) {
    const i = childrenOf(block).indexOf(blockId);
    if (i >= 0) return { parent: { blockId: id as BlockId }, index: i };
  }
  return null;
}

type Source = Pick<SnippetTemplatePayload, 'blocks' | 'purposes' | 'rules'>;

/** Where the inline (default-locale) text of a TextKey lives in a snippet: the holder object and its field. */
function textAt(key: string, source: Source): { holder: Rec; field: string } | null {
  const [prefix = '', id = '', ...rest] = key.split(':');
  const part = rest.join(':');
  const at = (holder: unknown, field: string) => (isRec(holder) && holder[field] !== undefined ? { holder, field } : null);
  const block = (blockId: string): Rec | undefined => {
    const b: unknown = source.blocks[blockId as BlockId];
    return isRec(b) ? b : undefined;
  };
  const config = (blockId: string): Rec | undefined => {
    const c = block(blockId)?.['config'];
    return isRec(c) ? c : undefined;
  };
  const byId = (list: unknown, itemId: string): unknown => (Array.isArray(list) ? list.find((item: unknown) => isRec(item) && item['id'] === itemId) : undefined);
  switch (prefix) {
    case 'block':
      return part === 'label' || part === 'description' ? at(block(id), part) : at(config(id), part);
    case 'option': {
      const [blockId = '', optionId = ''] = id.split('/');
      return at(byId(config(blockId)?.['options'], optionId), 'label');
    }
    case 'consent':
      if (part === 'notice') return at(config(id), 'notice');
      if (part === 'withdrawal') return at(config(id), 'withdrawalText');
      return part.startsWith('item:') ? at(byId(config(id)?.['items'], part.slice(5)), 'label') : null;
    case 'purpose':
      return at(source.purposes.find((p) => p.id === id), part);
    case 'rule':
      return at(source.rules.find((r) => r.id === id)?.then[Number(part)], 'message');
    default:
      return null;
  }
}

/**
 * The snippet's text in the form's default locale: each inline text with a `locale` translation is replaced
 * by it, and the inline text it replaced is returned by key (the snippet's own-locale messages).
 */
function localise(payload: SnippetTemplatePayload, locale: Locale): { source: Source; own: Map<string, TranslationEntry['value']> } {
  const source: Source = { blocks: cloneJson(payload.blocks), purposes: cloneJson(payload.purposes), rules: cloneJson(payload.rules) };
  const own = new Map<string, TranslationEntry['value']>();
  for (const [key, entry] of Object.entries(payload.i18n.messages[locale] ?? {})) {
    const spot = entry && !key.startsWith('tplvar:') ? textAt(key, source) : null;
    if (!entry || !spot) continue;
    own.set(key, spot.holder[spot.field] as TranslationEntry['value']);
    spot.holder[spot.field] = cloneJson(entry.value);
  }
  return { source, own };
}

/** A purpose with the same notice content (name, description, basis, retention, marketing, recipients) as `p`. */
const purposeContent = (p: Purpose): string => canonicalJson({ ...p, id: null, origin: null });

/**
 * `insertSnippet(version, form, at, ctx)` (templates spec §3.1, TPL-15): the snippet's block subtree, rules,
 * logic variables, purposes and translations as `DocumentOp[]` for the builder's command layer (undoable like
 * any edit). Ids are `uuidv5(idSeed, sourceId)`; keys that clash with the form's get a suffix (`pan` → `pan_2`)
 * and `keyMap` maps every snippet key to its instance key; a purpose identical to one the form already declares
 * is reused instead of added. Inserted after `at.afterBlockId` (in its page or container), else at the
 * snippet's preferred position on `at.pageId`.
 */
export const insertSnippet = ((version: TemplateVersion, form: FormDefinition, at: { pageId: PageId; afterBlockId?: BlockId }, ctx: Parameters<InsertSnippet>[3], options: EngineOptions = {}): InsertSnippetResult => {
  const payload = version.payload;
  if (payload.kind !== 'snippet') throw new TemplateCoreError('wrong_template_kind', `insertSnippet needs a snippet template, not '${payload.kind}'`);
  const page = form.pages.find((p) => p.id === at.pageId);
  if (!page) throw new TemplateCoreError('page_not_found', `page '${at.pageId}' is not in the form`);
  const root = payload.blocks[payload.rootId];
  if (!root) throw new TemplateCoreError('block_not_found', `snippet root '${payload.rootId}' is not in the snippet`);
  let place: { parent: Parent; index: number };
  if (at.afterBlockId !== undefined) {
    const after = placementOf(form, at.afterBlockId);
    if (!after) throw new TemplateCoreError('block_not_found', `block '${at.afterBlockId}' is not placed in the form`);
    place = { parent: after.parent, index: after.index + 1 };
  } else {
    place = { parent: { pageId: page.id }, index: payload.insertHints.preferredPosition === 'start' ? 0 : page.children.length };
  }
  if (payload.insertHints.oncePerForm) {
    const inserted = options.bindings
      ? options.bindings.some((b) => b.kind === 'snippet' && b.templateId === version.templateId && b.instanceRootId !== undefined && form.blocks[b.instanceRootId as BlockId] !== undefined)
      : Object.values(form.blocks).some((b) => b && b.type === root.type && 'origin' in b && b.origin?.sourceId === payload.rootId);
    if (inserted) throw new TemplateCoreError('snippet_already_inserted', `this snippet may be inserted once per form`);
  }

  const ids = new IdAllocator(seedNamespace(ctx.idSeed));
  const bindingId = uuidv5(seedNamespace(ctx.bindingIdSeed), 'snippet');
  const warnings: TemplateWarning[] = [];

  /* A snippet written in another default locale is inserted in the form's; its own text becomes that locale's messages. */
  const locale = form.i18n.defaultLocale;
  const ownLocale = payload.i18n.defaultLocale;
  let source: Source = payload;
  let own = new Map<string, TranslationEntry['value']>();
  if (ownLocale !== locale) {
    if (payload.i18n.messages[locale]) ({ source, own } = localise(payload, locale));
    else warnings.push({ code: 'locale_incomplete', message: `The snippet has no ${locale} text; its ${ownLocale} text is inserted`, at: locale });
  }

  /* The subtree in pre-order, with each block's parent source id. */
  const subtree: Array<{ block: Block; parent: string | null; index: number }> = [];
  const visit = (id: BlockId, parent: string | null, index: number) => {
    const block = source.blocks[id];
    if (!block || subtree.some((s) => s.block.id === id)) return;
    subtree.push({ block, parent, index });
    childrenOf(block).forEach((child, i) => visit(child, id, i));
  };
  visit(payload.rootId, null, place.index);

  subtree.forEach(({ block }) => ids.alloc('element', block.id));
  source.rules.forEach((r) => ids.alloc('rule', r.id));
  payload.logicVariables.forEach((v) => ids.alloc('variable', v.id));
  conditionIds([subtree.map((s) => s.block), source.rules, payload.logicVariables]).forEach((c) => ids.alloc('condition', c));
  const existing = new Map(form.privacy.purposes.map((p) => [purposeContent(p), p.id]));
  const added: Purpose[] = [];
  for (const purpose of source.purposes) {
    const same = existing.get(purposeContent(purpose));
    if (same !== undefined) ids.idMap[mapKey('purpose', purpose.id)] = same;
    else added.push(purpose);
    ids.alloc('purpose', purpose.id);
  }

  const taken = new Set<string>();
  for (const b of Object.values(form.blocks)) if (b && 'key' in b) taken.add(b.key);
  for (const v of form.logic.variables) taken.add(v.key);
  const keyMap: Record<string, FieldKey> = {};
  const claim = (key: FieldKey) => {
    const next = uniqueKey(key, taken) as FieldKey;
    taken.add(next);
    keyMap[key] = next;
    if (next !== key) warnings.push({ code: 'key_renamed', message: `Key '${key}' is already used in this form; the snippet's field uses '${next}'`, at: key });
  };
  for (const { block } of subtree) if ('key' in block) claim(block.key);
  for (const v of payload.logicVariables) claim(v.key);
  const remap = ids.remap(keyMap);

  const baker = new Baker(payload.variables, { ...ctx, formTitle: form.title }, variableNames(payload));
  const content = <T>(value: T, at: Locale = locale): T => baker.bake(remapRefs(value, remap), at);

  const ops: DocumentOp[] = [];
  const blocks: Block[] = [];
  for (const { block, parent, index } of subtree) {
    const id = remap.id('element', block.id) as BlockId;
    const instance = { ...content(block), id, ...('key' in block ? { key: remap.key(block.key) } : {}), origin: origin(bindingId, block.id) } as Block;
    blocks.push(instance);
    ops.push({ op: 'add_block', block: instance, parent: parent === null ? place.parent : { blockId: remap.id('element', parent) as BlockId }, index });
  }
  source.rules.forEach((rule, i) => {
    ops.push({ op: 'add_rule', rule: { ...content(rule), id: remap.id('rule', rule.id) as typeof rule.id, origin: origin(bindingId, rule.id) }, index: form.logic.rules.length + i });
  });
  for (const v of payload.logicVariables) {
    ops.push({ op: 'add_variable', variable: { ...content(v), id: remap.id('variable', v.id) as typeof v.id, key: remap.key(v.key) as FieldKey, origin: origin(bindingId, v.id) } });
  }
  for (const p of added) ops.push({ op: 'add_purpose', purpose: { ...content(p), id: remap.id('purpose', p.id) as typeof p.id, origin: origin(bindingId, p.id) } });

  const formLocales = form.i18n.locales.map((l) => l.locale).filter((l) => l !== locale);
  const snippetLocales = new Set<string>(payload.i18n.locales.map((l) => l.locale));
  for (const l of formLocales) {
    if (l === ownLocale) {
      const out: Partial<Record<TextKey, TranslationEntry>> = {};
      for (const [key, value] of own) {
        const spot = textAt(key, source);
        out[remapTextKey(key as TextKey, remap)] = { value: content(value, l), sourceHash: contentHash(spot ? content(spot.holder[spot.field]) : null), origin: 'template' };
      }
      if (own.size) ops.push({ op: 'set_messages', locale: l, entries: out });
      continue;
    }
    const entries = payload.i18n.messages[l];
    if (!snippetLocales.has(l) || !entries) {
      warnings.push({ code: 'locale_incomplete', message: `The snippet has no ${l} translation`, at: l });
      continue;
    }
    const out: Partial<Record<TextKey, TranslationEntry>> = {};
    for (const [key, entry] of Object.entries(entries)) {
      if (entry && !key.startsWith('tplvar:')) out[remapTextKey(key as TextKey, remap)] = { ...content(entry, l), origin: 'template' };
    }
    ops.push({ op: 'set_messages', locale: l, entries: out });
  }

  warnings.push(...sensitiveWarning(blocks), ...baker.warnings(locale));
  const instanceRootId = remap.id('element', payload.rootId);
  return {
    ops,
    binding: binding(bindingId, 'snippet', version, form.formId, options.actor ?? OFFLINE_ACTOR, ctx.now, ids.idMap, { instanceRootId, keyMap }),
    keyMap,
    warnings,
  };
}) satisfies InsertSnippet;

/**
 * Applies `DocumentOp`s to a definition (what the builder's command layer and the API's snippet endpoint do).
 * `add_block` registers the block and makes it the `index`-th child of its parent; a container added with its
 * children already listed keeps them in place, so applying is idempotent per op.
 */
export function applyDocumentOps(form: FormDefinition, ops: readonly DocumentOp[]): FormDefinition {
  let def = form;
  const place = (list: readonly BlockId[], id: BlockId, index: number): BlockId[] =>
    list[index] === id ? [...list] : [...list.slice(0, index).filter((b) => b !== id), id, ...list.slice(index).filter((b) => b !== id)];
  for (const op of ops) {
    switch (op.op) {
      case 'add_block': {
        const blocks: FormDefinition['blocks'] = { ...def.blocks, [op.block.id]: op.block };
        const parent = op.parent;
        if ('pageId' in parent) {
          def = { ...def, blocks, pages: def.pages.map((p) => (p.id === parent.pageId ? { ...p, children: place(p.children, op.block.id, op.index) } : p)) };
        } else {
          const container = blocks[parent.blockId];
          if (container?.type === 'section' || container?.type === 'repeating_group') {
            blocks[parent.blockId] = { ...container, config: { ...container.config, children: place(container.config.children, op.block.id, op.index) } } as StoredBlock;
          }
          def = { ...def, blocks };
        }
        break;
      }
      case 'add_rule': {
        const rules = [...def.logic.rules];
        rules.splice(op.index, 0, op.rule);
        def = { ...def, logic: { ...def.logic, rules } };
        break;
      }
      case 'add_variable':
        def = { ...def, logic: { ...def.logic, variables: [...def.logic.variables, op.variable] } };
        break;
      case 'add_purpose':
        def = { ...def, privacy: { ...def.privacy, purposes: [...def.privacy.purposes, op.purpose] } };
        break;
      case 'set_messages':
        def = { ...def, i18n: { ...def.i18n, messages: { ...def.i18n.messages, [op.locale]: { ...def.i18n.messages[op.locale], ...op.entries } } } };
        break;
    }
  }
  return def;
}
