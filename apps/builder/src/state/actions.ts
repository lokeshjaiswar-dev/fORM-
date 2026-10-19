import type { AvailableType } from '@form/registry';
import type {
  Behavior, BlockConfigMap, BlockId, DocumentOp, Ending, EndingId, FormDefinition, PageId, Purpose, PurposeId, RichDoc, Rule, RuleId, Theme,
} from '@form/schema';
import { APP_IDS, blankDefinition, createBlock, isField, placementOf, richDoc } from '@/lib/definition';
import { dispatch, type CommandResult } from '@/state/commands/dispatch';
import { rulesReading } from '@/state/commands/rules';
import type { BlockPatch, PageSlot, RuleFate } from '@/state/commands/types';
import { currentDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';

/*
 * What the builder UI calls: each action dispatches one command, then moves the selection, and returns the command's
 * result. The selection and the copied block live in the UI store, so they never enter undo history.
 */

const ui = () => useUiStore.getState();

/** A registry palette entry to insert (FND-03): the type and the entry's config overrides. */
export interface BlockChoice {
  type: AvailableType;
  configOverrides: Partial<BlockConfigMap[AvailableType]>;
}

/** The end of the last page. */
export function endSlot(doc: FormDefinition = currentDoc()): PageSlot {
  const page = doc.pages[doc.pages.length - 1] as FormDefinition['pages'][number];
  return { pageId: page.id, index: page.children.length };
}

/** Right after a top-level block; the end of the form when the block is not on a page. */
export function slotAfter(id: BlockId, doc: FormDefinition = currentDoc()): PageSlot {
  const at = placementOf(doc, id);
  return at && 'pageId' in at.parent ? { pageId: at.parent.pageId, index: at.index + 1 } : endSlot(doc);
}

export function setTitle(title: string): CommandResult {
  return dispatch({ type: 'set_title', title });
}

export function setDescription(description: RichDoc | null): CommandResult {
  return dispatch({ type: 'set_description', description });
}

export function setTheme(theme: Theme): CommandResult {
  return dispatch({ type: 'set_theme', theme });
}

export function setBehavior(behavior: Behavior): CommandResult {
  return dispatch({ type: 'set_behavior', behavior });
}

/** Sets the endings, and the behaviour that goes with them (the confetti switch) in the same step. */
export function setEndings(endings: Ending[], defaultEndingId: EndingId, behavior?: Behavior): CommandResult {
  return dispatch({ type: 'set_endings', endings, defaultEndingId, ...(behavior ? { behavior } : {}) });
}

/**
 * A new block for a palette entry. Personal data needs a purpose (I7): on a form without one, a field brings the
 * default purpose, which the caller adds in the same step as the block.
 */
const defaultPurpose = (doc: FormDefinition): Purpose => ({ ...(blankDefinition(doc.formId).privacy.purposes[0] as Purpose), id: APP_IDS.newId() as PurposeId });

function newBlock(choice: BlockChoice, doc: FormDefinition): { block: ReturnType<typeof createBlock>; purpose?: Purpose } {
  if (choice.type === 'heading' || choice.type === 'paragraph' || choice.type === 'divider' || doc.privacy.purposes.length) return { block: createBlock(choice, doc) };
  const purpose = defaultPurpose(doc);
  return { block: createBlock(choice, { ...doc, privacy: { ...doc.privacy, purposes: [purpose] } }), purpose };
}

/** Adds a block for a palette entry at `at` (the end by default), selects it and returns its id ('' when refused). */
export function addBlock(choice: BlockChoice, at: PageSlot = endSlot(), patch: BlockPatch = {}): BlockId | '' {
  const made = newBlock(choice, currentDoc());
  const ops: DocumentOp[] = made.purpose ? [{ op: 'add_purpose', purpose: made.purpose }] : [];
  const block = { ...made.block, ...patch } as ReturnType<typeof createBlock>;
  ops.push({ op: 'add_block', block, parent: { pageId: at.pageId }, index: at.index });
  const result = dispatch({ type: 'apply_ops', ops });
  if (!result.ok) return '';
  useUiStore.setState({ activeBlockId: block.id, started: true });
  return block.id;
}

/** A paragraph block holding `text`, as typing on the insert line makes. */
export function addParagraph(text: string, at: PageSlot = endSlot()): BlockId | '' {
  return addBlock({ type: 'paragraph', configOverrides: {} }, at, { config: { content: richDoc(text) } });
}

/** A page break at `at`: the blocks from there on move to a new page. */
export function insertPageBreak(at: PageSlot = endSlot()): CommandResult {
  const result = dispatch({ type: 'split_page', pageId: at.pageId, index: at.index, newPageId: APP_IDS.newId() as PageId });
  if (result.ok) useUiStore.setState({ started: true });
  return result;
}

/** Removes the page break before `pageId`: its blocks join the page before. */
export function removePageBreak(pageId: PageId): CommandResult {
  return dispatch({ type: 'merge_page', pageId });
}

export function updateBlock(id: BlockId, patch: BlockPatch): CommandResult {
  return dispatch({ type: 'update_block', id, patch });
}

export function setBlockWidth(id: BlockId, width: 'full' | 'half'): CommandResult {
  return dispatch({ type: 'set_width', id, width });
}

export function deleteBlock(id: BlockId, rules: RuleFate = 'disable'): CommandResult {
  const result = dispatch({ type: 'delete_block', id, rules });
  if (!result.ok) return result;
  const { activeBlockId, pendingDelete } = ui();
  useUiStore.setState({
    ...(activeBlockId === id ? { activeBlockId: null, inspectorOpen: false } : {}),
    ...(pendingDelete === id ? { pendingDelete: null } : {}),
  });
  return result;
}

/** Deletes at once, or first asks what to do with the rules that read the block (B21). */
export function requestDeleteBlock(id: BlockId): void {
  if (rulesReading(currentDoc(), id).length) ui().setPendingDelete(id);
  else deleteBlock(id);
}

export function duplicateBlock(id: BlockId): CommandResult {
  const result = dispatch({ type: 'duplicate_block', id });
  if (result.ok && result.created) ui().setActiveBlock(result.created);
  return result;
}

/** Puts a copy of the block on the builder's block clipboard (BL-144); the document does not change. */
export function copyBlock(id: BlockId): boolean {
  const block = currentDoc().blocks[id];
  if (!block || block.type === 'unsupported') return false;
  useUiStore.setState({ clipboard: structuredClone(block) });
  return true;
}

/**
 * Pastes the copied block after the selected block (or at the end): a fresh id and key, no origin and no rules. A
 * personal-data field pasted into a form without a purpose brings the default one in the same step (I7).
 */
export function pasteBlock(at?: PageSlot): CommandResult {
  const { clipboard, activeBlockId } = ui();
  if (!clipboard) return { ok: false, error: 'nothing to paste' };
  const slot = at ?? (activeBlockId ? slotAfter(activeBlockId) : endSlot());
  const doc = currentDoc();
  const needsPurpose = isField(clipboard) && clipboard.compliance.classification !== 'none' && !doc.privacy.purposes.length;
  const result = dispatch({ type: 'paste_block', block: clipboard, at: slot, ...(needsPurpose ? { purpose: defaultPurpose(doc) } : {}) });
  if (result.ok && result.created) useUiStore.setState({ activeBlockId: result.created, started: true });
  return result;
}

export function moveBlock(id: BlockId, to: PageSlot): CommandResult {
  return dispatch({ type: 'move_block', id, to });
}

export function placeBeside(hostId: BlockId, payload: { choice: BlockChoice } | { id: BlockId }): CommandResult {
  const source = 'choice' in payload ? newBlock(payload.choice, currentDoc()) : payload;
  const result = dispatch({ type: 'place_beside', hostId, source });
  if (result.ok) useUiStore.setState({ activeBlockId: result.created ?? ui().activeBlockId, started: true });
  return result;
}

export function setRule(rule: Rule): CommandResult {
  return dispatch({ type: 'set_rule', rule });
}

export function removeRule(id: RuleId): CommandResult {
  return dispatch({ type: 'remove_rule', id });
}

/** Replaces the whole form (a template) and keeps its id; one undoable step. */
export function replaceDocument(doc: FormDefinition): CommandResult {
  const result = dispatch({ type: 'replace_document', doc: { ...doc, formId: currentDoc().formId } });
  if (result.ok) useUiStore.setState({ activeBlockId: null, inspectorOpen: false, started: true });
  return result;
}
