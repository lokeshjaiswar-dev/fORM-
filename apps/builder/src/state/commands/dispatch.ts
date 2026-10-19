import { produce } from 'immer';
import { V1 } from '@form/schema';
import { uid } from '@/lib/utils';
import type { FormSchema } from '@/types/form';
import { addBlock, deleteBlock, duplicateBlock, moveBlock, placeBeside, setWidth, updateBlock, type IdSource } from '@/state/commands/blocks';
import { CommandSchema, type Command } from '@/state/commands/types';
import { commit } from '@/state/history';
import { currentDoc } from '@/state/documentStore';

export type CommandResult = { ok: true; doc: FormSchema; created?: string } | { ok: false; error: string };

const APP_IDS: IdSource = { newId: uid };

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

const has = (doc: FormSchema, id: string) => doc.blocks.some((b) => b.id === id);

/** What the command needs from the document it applies to; null when it can apply. */
function precondition(doc: FormSchema, command: Command): string | null {
  const n = doc.blocks.length;
  switch (command.type) {
    case 'add_block':
      if (has(doc, command.block.id)) return `block '${command.block.id}' already exists`;
      return command.index > n ? `index ${command.index} is past the end` : null;
    case 'update_block':
    case 'set_width':
    case 'delete_block':
    case 'duplicate_block':
      return has(doc, command.id) ? null : `no block '${command.id}'`;
    case 'move_block':
      return command.from < n && command.to < n ? null : `move ${command.from} → ${command.to} is out of range`;
    case 'place_beside':
      if (!has(doc, command.hostId)) return `no block '${command.hostId}'`;
      if ('block' in command.source) return has(doc, command.source.block.id) ? `block '${command.source.block.id}' already exists` : null;
      if (command.source.id === command.hostId) return `block '${command.hostId}' cannot sit beside itself`;
      return has(doc, command.source.id) ? null : `no block '${command.source.id}'`;
    case 'replace_document':
      return command.doc.id === doc.id ? null : `document '${command.doc.id}' is not '${doc.id}'`;
    default:
      return null;
  }
}

/**
 * Applies one command to a document, purely: the command is checked against its twin and the document, and the
 * result shares every untouched object with `doc`. Invalid commands change nothing.
 */
export function applyCommand(doc: FormSchema, input: Command, ids: IdSource = APP_IDS): CommandResult {
  const command = normalize(input);
  const parsed = CommandSchema.safeParse(command);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || command.type}: ${i.message}`).join('; ') };
  const problem = precondition(doc, command);
  if (problem) return { ok: false, error: problem };
  let created: string | undefined;
  const next = produce(doc, (draft) => {
    switch (command.type) {
      case 'set_title':
        draft.title = command.title;
        break;
      case 'set_description':
        draft.description = command.description;
        break;
      case 'update_settings':
        Object.assign(draft.settings, command.patch);
        break;
      case 'add_block':
        addBlock(draft, command.block, command.index);
        created = command.block.id;
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
      case 'move_block':
        moveBlock(draft, command.from, command.to);
        break;
      case 'place_beside':
        created = placeBeside(draft, command.hostId, command.source);
        break;
      case 'replace_document':
        return command.doc;
    }
  });
  if (command.type === 'update_block') {
    const edited = V1.FormBlockSchema.safeParse(next.blocks.find((b) => b.id === command.id));
    if (!edited.success) return { ok: false, error: `the edit leaves block '${command.id}' invalid: ${edited.error.issues[0]?.message ?? 'unknown issue'}` };
  }
  return { ok: true, doc: next, ...(created !== undefined ? { created } : {}) };
}

type Change = { path: string; value: unknown; structural?: true };

/** An array element's identity: its `id` when it has one (options), else its index. */
const itemKey = (item: unknown, index: number) => (isPlain(item) && typeof item.id === 'string' ? item.id : String(index));

/**
 * The leaf paths `after` changes in `before` (`customize.prefix`, `options.<id>.label`). An array whose length or
 * order changes is one structural change; an array edited in place descends per element.
 */
function changes(before: unknown, after: unknown, path: string): Change[] {
  if (isPlain(after) && (before === undefined || isPlain(before))) {
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
function typingKey(prefix: string, current: Plain, patch: Plain): string | null {
  const changed = Object.entries(patch).flatMap(([k, v]) => changes(current[k], v, k));
  if (!changed.length || changed.some((c) => c.structural) || changed.every((c) => typeof c.value === 'boolean')) return null;
  return `${prefix}:${changed.map((c) => c.path).sort().join(',')}`;
}

/** Typing commands that coalesce into one history step: one key per (block, path), or per form field. */
export function coalesceKey(command: Command, doc: FormSchema): string | null {
  switch (command.type) {
    case 'set_title':
      return 'title';
    case 'set_description':
      return 'description';
    case 'update_settings':
      return typingKey('settings', doc.settings as unknown as Plain, command.patch);
    case 'update_block': {
      const target = doc.blocks.find((b) => b.id === command.id);
      return target ? typingKey(`block:${command.id}`, target as unknown as Plain, command.patch) : null;
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
