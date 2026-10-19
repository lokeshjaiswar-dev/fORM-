import { produce } from 'immer';
import { BLOCK_SCHEMAS, type BlockId, type BlockType, type FormDefinition, type StoredBlock } from '@form/schema';
import { applyDocumentOps } from '@form/templates-core';
import { APP_IDS, KEY_PATTERN, childrenOf, isField, placementOf, takenKeys, type IdSource } from '@/lib/definition';
import { deleteBlock, duplicateBlock, moveBlock, pasteBlock, placeBeside, setWidth, updateBlock } from '@/state/commands/blocks';
import { mergePage, splitPage } from '@/state/commands/pages';
import { ruleTargets, syncInitiallyHidden } from '@/state/commands/rules';
import { CommandSchema, type Command } from '@/state/commands/types';
import { commit } from '@/state/history';
import { currentDoc } from '@/state/documentStore';

export type CommandResult = { ok: true; doc: FormDefinition; created?: BlockId } | { ok: false; error: string };

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON semantics: keys whose value is `undefined` are absent. */
function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as T;
  if (!isPlain(value)) return value;
  const out: Plain = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = compact(v);
  return out as T;
}

/** A patch keeps its top-level `undefined` values: they unset that part of the block. */
function normalize(command: Command): Command {
  if (command.type !== 'update_block') return compact(command);
  const patch: Plain = {};
  for (const [k, v] of Object.entries(command.patch)) patch[k] = v === undefined ? undefined : compact(v);
  return { ...command, patch };
}

const has = (doc: FormDefinition, id: string) => doc.blocks[id as BlockId] !== undefined;
const hasPage = (doc: FormDefinition, id: string) => doc.pages.some((p) => p.id === id);
const placedOnPage = (doc: FormDefinition, id: BlockId) => doc.pages.some((p) => p.children.includes(id));
const pageLength = (doc: FormDefinition, id: string) => doc.pages.find((p) => p.id === id)?.children.length ?? -1;

/** Element ids share one namespace (I1): blocks, pages and endings. */
const idTaken = (doc: FormDefinition, id: string) => has(doc, id) || hasPage(doc, id) || doc.endings.some((e) => e.id === id);

function opsProblem(doc: FormDefinition, command: Extract<Command, { type: 'apply_ops' }>): string | null {
  const ids = new Set<string>();
  const keys = takenKeys(doc);
  for (const op of command.ops) {
    if (op.op === 'add_block') {
      if (idTaken(doc, op.block.id) || ids.has(op.block.id)) return `block '${op.block.id}' already exists`;
      ids.add(op.block.id);
      if (isField(op.block)) {
        if (keys.has(op.block.key)) return `key '${op.block.key}' is already used`;
        keys.add(op.block.key);
      }
      const parent = op.parent;
      if ('pageId' in parent ? !hasPage(doc, parent.pageId) : !has(doc, parent.blockId) && !ids.has(parent.blockId)) return 'the parent of a new block does not exist';
    }
    if (op.op === 'add_rule' && (doc.logic.rules.some((r) => r.id === op.rule.id) || op.index > doc.logic.rules.length + command.ops.length)) return `rule '${op.rule.id}' cannot be added`;
  }
  return null;
}

/** What the command needs from the document it applies to; null when it can apply. */
function precondition(doc: FormDefinition, command: Command): string | null {
  switch (command.type) {
    case 'set_endings':
      return command.endings.some((e) => e.id === command.defaultEndingId) ? null : `ending '${command.defaultEndingId}' is not one of the endings`;
    case 'apply_ops':
      return opsProblem(doc, command);
    case 'update_block': {
      if (!has(doc, command.id)) return `no block '${command.id}'`;
      if ('id' in command.patch || 'type' in command.patch) return 'a block keeps its id and type';
      const key = command.patch['key'];
      if (key !== undefined && (typeof key !== 'string' || !KEY_PATTERN.test(key) || takenKeys(doc, command.id).has(key))) return `key '${String(key)}' is not a free key`;
      return null;
    }
    case 'set_width':
    case 'delete_block':
      return has(doc, command.id) && placementOf(doc, command.id) ? null : `no placed block '${command.id}'`;
    case 'duplicate_block':
      if (!placementOf(doc, command.id)) return `no placed block '${command.id}'`;
      return childrenOf(doc.blocks[command.id]).length ? 'a block with children cannot be copied yet' : null;
    case 'paste_block':
      if (childrenOf(command.block).length) return 'a block with children cannot be pasted yet';
      if (command.purpose && doc.privacy.purposes.some((p) => p.id === command.purpose?.id)) return `purpose '${command.purpose.id}' already exists`;
      return hasPage(doc, command.at.pageId) && command.at.index <= pageLength(doc, command.at.pageId) ? null : 'no such page position';
    case 'move_block': {
      if (!placedOnPage(doc, command.id)) return `no block '${command.id}' on a page`;
      const same = doc.pages.find((p) => p.id === command.to.pageId)?.children.includes(command.id) ? 1 : 0;
      return hasPage(doc, command.to.pageId) && command.to.index <= pageLength(doc, command.to.pageId) - same ? null : 'no such page position';
    }
    case 'place_beside':
      if (!placementOf(doc, command.hostId)) return `no placed block '${command.hostId}'`;
      if ('block' in command.source) {
        const { block, purpose } = command.source;
        if (purpose && doc.privacy.purposes.some((p) => p.id === purpose.id)) return `purpose '${purpose.id}' already exists`;
        return idTaken(doc, block.id) ? `block '${block.id}' already exists` : null;
      }
      if (command.source.id === command.hostId) return `block '${command.hostId}' cannot sit beside itself`;
      return placementOf(doc, command.source.id) ? null : `no placed block '${command.source.id}'`;
    case 'split_page':
      if (idTaken(doc, command.newPageId)) return `'${command.newPageId}' is already used`;
      return command.index <= pageLength(doc, command.pageId) ? null : 'no such page position';
    case 'merge_page':
      return doc.pages.findIndex((p) => p.id === command.pageId) > 0 ? null : `page '${command.pageId}' has no page before it`;
    case 'remove_rule':
      return doc.logic.rules.some((r) => r.id === command.id) ? null : `no rule '${command.id}'`;
    case 'replace_document':
      return command.doc.formId === doc.formId ? null : `document '${command.doc.formId}' is not '${doc.formId}'`;
    default:
      return null;
  }
}

/** The edited block against its strict twin, so a patch can never leave it invalid. */
function blockProblem(block: StoredBlock | undefined): string | null {
  if (!block || block.type === 'unsupported') return null;
  const parsed = BLOCK_SCHEMAS[block.type as BlockType].safeParse(block);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'unknown issue');
}

/**
 * Applies one command to a document, purely: the command is checked against its twin and the document, and the
 * result shares every untouched object with `doc`. Invalid commands change nothing.
 */
export function applyCommand(doc: FormDefinition, input: Command, ids: IdSource = APP_IDS): CommandResult {
  const command = normalize(input);
  const parsed = CommandSchema.safeParse(command);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || command.type}: ${i.message}`).join('; ') };
  const problem = precondition(doc, command);
  if (problem) return { ok: false, error: problem };
  if (command.type === 'replace_document') return { ok: true, doc: command.doc };
  if (command.type === 'apply_ops') {
    const next = applyDocumentOps(doc, command.ops);
    const added = command.ops.flatMap((op) => (op.op === 'add_rule' ? ruleTargets(op.rule) : []));
    const first = command.ops.find((op) => op.op === 'add_block');
    const synced = added.length ? produce(next, (draft) => syncInitiallyHidden(draft, added)) : next;
    return { ok: true, doc: synced, ...(first?.op === 'add_block' ? { created: first.block.id } : {}) };
  }
  let created: BlockId | undefined;
  const next = produce(doc, (draft) => {
    switch (command.type) {
      case 'set_title':
        draft.title = command.title;
        break;
      case 'set_description':
        if (command.description) draft.description = command.description;
        else delete draft.description;
        break;
      case 'set_theme':
        draft.theme = command.theme;
        break;
      case 'set_behavior':
        draft.behavior = command.behavior;
        break;
      case 'set_endings':
        draft.endings = command.endings;
        draft.defaultEndingId = command.defaultEndingId;
        if (command.behavior) draft.behavior = command.behavior;
        break;
      case 'update_block':
        updateBlock(draft, command.id, command.patch);
        break;
      case 'set_width':
        setWidth(draft, command.id, command.width);
        break;
      case 'delete_block':
        deleteBlock(draft, command.id, command.rules);
        break;
      case 'duplicate_block':
        created = duplicateBlock(draft, command.id, ids);
        break;
      case 'paste_block':
        created = pasteBlock(draft, command.block, command.at, ids, command.purpose);
        break;
      case 'move_block':
        moveBlock(draft, command.id, command.to);
        break;
      case 'place_beside':
        created = placeBeside(draft, command.hostId, command.source);
        break;
      case 'split_page':
        splitPage(draft, command.pageId, command.index, command.newPageId);
        break;
      case 'merge_page':
        mergePage(draft, command.pageId);
        break;
      case 'set_rule': {
        const at = draft.logic.rules.findIndex((r) => r.id === command.rule.id);
        const before = at >= 0 ? ruleTargets(draft.logic.rules[at] as typeof command.rule) : [];
        if (at >= 0) draft.logic.rules[at] = command.rule;
        else draft.logic.rules.push(command.rule);
        syncInitiallyHidden(draft, [...before, ...ruleTargets(command.rule)]);
        break;
      }
      case 'remove_rule': {
        const rule = draft.logic.rules.find((r) => r.id === command.id);
        draft.logic.rules = draft.logic.rules.filter((r) => r.id !== command.id);
        if (rule) syncInitiallyHidden(draft, ruleTargets(rule));
        break;
      }
    }
  });
  if (command.type === 'update_block') {
    const problem = blockProblem(next.blocks[command.id]);
    if (problem) return { ok: false, error: `the edit leaves block '${command.id}' invalid: ${problem}` };
  }
  return { ok: true, doc: next, ...(created !== undefined ? { created } : {}) };
}

type Change = { path: string; value: unknown; structural?: true };

/** An array element's identity: its `id` when it has one (options, conditions), else its index. */
const itemKey = (item: unknown, index: number) => (isPlain(item) && typeof item['id'] === 'string' ? item['id'] : String(index));

/** Rich text (labels, descriptions, content) is one value: typing in it is one leaf, whatever its node structure. */
const isRichText = (v: unknown) => isPlain(v) && v['type'] === 'doc';

/**
 * The leaf paths `after` changes in `before` (`config.prefix`, `config.options.<id>.label`). An array whose length or
 * order changes is one structural change; an array edited in place descends per element.
 */
function changes(before: unknown, after: unknown, path: string): Change[] {
  if (isPlain(after) && !isRichText(after) && (before === undefined || (isPlain(before) && !isRichText(before)))) {
    const was: Plain = before ?? {};
    return [...new Set([...Object.keys(was), ...Object.keys(after)])].flatMap((k) => changes(was[k], after[k], `${path}.${k}`));
  }
  if (Array.isArray(after) && Array.isArray(before)) {
    const keys = after.map(itemKey);
    if (keys.length !== before.length || before.some((item, i) => itemKey(item, i) !== keys[i])) return [{ path, value: after, structural: true }];
    return after.flatMap((item, i) => changes(before[i], item, `${path}.${keys[i]}`));
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [{ path, value: after, ...(Array.isArray(after) || Array.isArray(before) ? { structural: true as const } : {}) }];
}

/**
 * Typing coalesces per changed path; a toggle (every changed value a boolean), a structural array change (an option
 * added, removed or moved) or a no-op is its own step.
 */
function typingKey(prefix: string, current: unknown, next: Plain): string | null {
  const was: Plain = isPlain(current) ? current : {};
  const changed = Object.entries(next).flatMap(([k, v]) => changes(was[k], v, k));
  if (!changed.length || changed.some((c) => c.structural) || changed.every((c) => typeof c.value === 'boolean')) return null;
  return `${prefix}:${changed.map((c) => c.path).sort().join(',')}`;
}

/** Typing commands that coalesce into one history step: one key per (block, path), rule or form part. */
export function coalesceKey(command: Command, doc: FormDefinition): string | null {
  switch (command.type) {
    case 'set_title':
      return 'title';
    case 'set_description':
      return command.description ? 'description' : null;
    case 'set_theme':
      return typingKey('theme', doc.theme, command.theme as unknown as Plain);
    case 'set_behavior':
      return typingKey('behavior', doc.behavior, command.behavior as unknown as Plain);
    case 'set_endings':
      if (command.behavior) return null;
      return typingKey('endings', { endings: doc.endings, defaultEndingId: doc.defaultEndingId }, { endings: command.endings, defaultEndingId: command.defaultEndingId });
    case 'update_block': {
      const target = doc.blocks[command.id];
      return target ? typingKey(`block:${command.id}`, target, command.patch as Plain) : null;
    }
    case 'set_rule': {
      const rule = doc.logic.rules.find((r) => r.id === command.rule.id);
      return rule ? typingKey(`rule:${rule.id}`, rule, command.rule as unknown as Plain) : null;
    }
    default:
      return null;
  }
}

/** The one way to change the open document: validated, applied, recorded in history (typing coalesced). */
export function dispatch(command: Command, ids: IdSource = APP_IDS): CommandResult {
  const doc = currentDoc();
  const result = applyCommand(doc, command, ids);
  if (result.ok) commit(result.doc, coalesceKey(command, doc));
  else if (import.meta.env.MODE === 'development') console.warn(`builder: ${command.type} rejected: ${result.error}`);
  return result;
}
